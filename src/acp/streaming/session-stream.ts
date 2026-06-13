/**
 * SerializableSessionStream persists stream parts and file snapshots to JSONL.
 *
 * Writes SerializableStreamPart records, the extension's stable concept model
 * for chat, tool, interaction, and edit metadata.
 * File snapshots continue to be delegated to the checkpoint store.
 *
 * Layout per session:
 *   {workspaceRoot}/.acpilot/{backendName}/{sessionId}/
 *     turns.jsonl          stream parts/events + inline snapshots
 *     _checkpoints.jsonl   dedicated checkpoint-store file
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ensureSessionDir } from './workspace-setup';
import {
  writeVersionHeader,
  writeMeta,
  writeTurnStart,
  writeTurnEnd,
  writeStreamPart,
  writeSnapshotLine,
} from '../serializable/serializer';
import { writeSnapshot } from '../checkpoint/checkpoint-store';
import { SerializableStreamPartEventHandler } from '../serializable/stream-parts';
import type { StreamingBridgeCallbacks } from '../../acp/backend';
import type {
  SerializableSessionMeta,
  FileSnapshotRecord,
  SerializableRequestDetails,
  SerializableStreamPart,
} from '../serializable/types';
import type { AcpEvent } from '../types';

const LOG_PREFIX = '[SerializableSessionStream]';

export class SerializableSessionStream implements StreamingBridgeCallbacks {
  private filePath: string | null = null;
  private sessionDir: string | null = null;
  private headerWritten = false;
  private isActive = true;
  private writeQueue: Promise<void> = Promise.resolve();
  private requestDetails: SerializableRequestDetails[] = [];
  private persistedMeta: SerializableSessionMeta;
  private readonly streamPartHandler: SerializableStreamPartEventHandler;

  constructor(
    private readonly workspaceRoot: string,
    private readonly backendName: string,
    private readonly sessionId: string,
    private readonly meta: SerializableSessionMeta,
    private readonly turnIndex = 0,
    private readonly prompt?: string,
    private readonly vscodeRequestId = `turn-${turnIndex}`,
  ) {
    this.persistedMeta = meta;
    this.streamPartHandler = new SerializableStreamPartEventHandler({
      turnIndex,
      requestId: vscodeRequestId,
      prompt,
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Initialise the session directory and write the JSONL header (version + meta).
   * Must be called once before any onEvent/onSnapshot calls.
   */
  async initialize(): Promise<void> {
    const sessionDir = await ensureSessionDir(
      this.workspaceRoot,
      this.backendName,
      this.sessionId,
    );
    this.sessionDir = sessionDir;
    this.filePath = path.join(sessionDir, 'turns.jsonl');
    const existingMeta = await readExistingSessionMeta(sessionDir);
    this.persistedMeta = existingMeta ? { ...this.meta, ...existingMeta } : this.meta;
    this.requestDetails = mergeRequestDetails(
      this.persistedMeta.requestDetails,
      this.meta.requestDetails,
    );
    this.persistedMeta = {
      ...this.persistedMeta,
      requestDetails: this.requestDetails,
    };
    const hasExistingContent = await fileHasContent(this.filePath);
    if (!hasExistingContent) {
      await writeVersionHeader(this.filePath);
      await writeMeta(this.filePath, this.persistedMeta as unknown as Record<string, unknown>);
    }
    await writeTurnStart(this.filePath, {
      turnIndex: this.turnIndex,
      prompt: this.prompt,
      timestamp: new Date().toISOString(),
    });
    this.headerWritten = true;
  }

  /**
   * Gracefully shut down the stream. Subsequent onEvent/onSnapshot calls
   * become no-ops.
   */
  close(): void {
    if (this.isActive) {
      this.enqueueWrite(async () => {
        if (!this.filePath) return;
        await this.ensureHeader();
        await writeTurnEnd(this.filePath, {
          turnIndex: this.turnIndex,
          timestamp: new Date().toISOString(),
        });
      });
    }
    this.isActive = false;
  }

  /** Get the JSONL file path (for diagnostics) */
  getFilePath(): string | null {
    return this.filePath;
  }

  // ── Callbacks ─────────────────────────────────────────────────────────

  /** Persist an ACP event as SSP records. */
  onEvent(event: AcpEvent): void {
    if (!this.isActive) return;
    this.enqueueWrite(async () => {
      if (!this.filePath) return;
      await this.ensureHeader();
      const parts = this.streamPartHandler.serializeEvent(event);
      for (const part of parts) {
        await writeStreamPart(this.filePath, part);
      }
    });
  }

  /**
   * Persist a file snapshot — both inline in `turns.jsonl` (for chronological
   * replay) and to the dedicated checkpoint store for structural access.
   */
  onSnapshot(snapshot: FileSnapshotRecord): void {
    if (!this.isActive) return;
    const snapshotWithTurn: FileSnapshotRecord = {
      ...snapshot,
      turnIndex: snapshot.turnIndex ?? this.turnIndex,
    };
    this.enqueueWrite(async () => {
      if (!this.filePath || !this.sessionDir) return;
      await this.ensureHeader();
      // Write inline to turns.jsonl for chronological replay
      await writeSnapshotLine(this.filePath, snapshotWithTurn);
      // Write to checkpoint store (_checkpoints.jsonl) for structural access
      await writeSnapshot(this.sessionDir, snapshotWithTurn);
    });
  }

  onExternalEdit(toolCallId: string, undoStopId: string): void {
    if (!this.isActive || !undoStopId) return;
    console.log(
      `${LOG_PREFIX} externalEdit recorded session=${this.sessionId} turn=${this.turnIndex} ` +
      `requestId=${this.vscodeRequestId} toolCallId=${toolCallId} undoStopId=${undoStopId}`,
    );
    const turnIndexRequestId = `turn-${this.turnIndex}`;
    const existing = this.requestDetails.find(details =>
      details.turnIndex === this.turnIndex ||
      details.vscodeRequestId === this.vscodeRequestId ||
      details.vscodeRequestId === turnIndexRequestId
    );
    if (existing) {
      existing.turnIndex = existing.turnIndex ?? this.turnIndex;
      existing.vscodeRequestId = this.vscodeRequestId;
      existing.toolIdEditMap = {
        ...existing.toolIdEditMap,
        [toolCallId]: undoStopId,
      };
    } else {
      this.requestDetails.push({
        turnIndex: this.turnIndex,
        vscodeRequestId: this.vscodeRequestId,
        toolIdEditMap: { [toolCallId]: undoStopId },
      });
    }

    this.enqueueWrite(async () => {
      if (!this.filePath || !this.sessionDir) return;
      await this.ensureHeader();
      await fs.writeFile(
        path.join(this.sessionDir, '_meta.json'),
        JSON.stringify({
          ...this.persistedMeta,
          requestDetails: this.requestDetails,
        }, null, 2),
        'utf-8',
      );
      await writeStreamPart(this.filePath, this.createExternalEditPart(toolCallId, undoStopId));
    });
  }

  /**
   * Handle a bridge error — logged but not written to the event stream.
   */
  onError(error: Error): void {
    console.error(`${LOG_PREFIX} Bridge error`, error);
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  /**
   * Ensure the version header and metadata lines have been written.
   * Idempotent after the first call.
   */
  private async ensureHeader(): Promise<void> {
    if (this.headerWritten || !this.filePath) return;
    this.headerWritten = true;
    const hasExistingContent = await fileHasContent(this.filePath);
    if (!hasExistingContent) {
      await writeVersionHeader(this.filePath);
      await writeMeta(this.filePath, this.persistedMeta as unknown as Record<string, unknown>);
    }
    await writeTurnStart(this.filePath, {
      turnIndex: this.turnIndex,
      prompt: this.prompt,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Queue an async write operation, ensuring sequential execution.
   */
  private enqueueWrite(fn: () => Promise<void>): void {
    this.writeQueue = this.writeQueue
      .then(() => fn())
      .catch((err: unknown) => {
        console.error(`${LOG_PREFIX} Write error to ${this.filePath}`, err);
      });
  }

  /** Wait for all pending writes to complete */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private createExternalEditPart(
    toolCallId: string,
    editId: string,
  ): SerializableStreamPart<'externalEdit', { toolCallId: string; editId: string }> {
    return this.streamPartHandler.createExternalEditPart(toolCallId, editId);
  }
}

async function fileHasContent(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.size > 0;
  } catch {
    return false;
  }
}

async function readExistingSessionMeta(sessionDir: string): Promise<SerializableSessionMeta | undefined> {
  try {
    const raw = await fs.readFile(path.join(sessionDir, '_meta.json'), 'utf-8');
    return JSON.parse(raw) as SerializableSessionMeta;
  } catch {
    return undefined;
  }
}

function mergeRequestDetails(
  ...sources: Array<readonly SerializableRequestDetails[] | undefined>
): SerializableRequestDetails[] {
  const result: SerializableRequestDetails[] = [];

  for (const source of sources) {
    for (const details of source ?? []) {
      const existing = result.find(item =>
        (details.turnIndex !== undefined && item.turnIndex === details.turnIndex) ||
        item.vscodeRequestId === details.vscodeRequestId
      );
      if (existing) {
        existing.turnIndex = details.turnIndex ?? existing.turnIndex;
        existing.vscodeRequestId = details.vscodeRequestId || existing.vscodeRequestId;
        existing.backendRequestId = details.backendRequestId ?? existing.backendRequestId;
        existing.toolIdEditMap = {
          ...existing.toolIdEditMap,
          ...(details.toolIdEditMap ?? {}),
        };
      } else {
        result.push({
          ...details,
          toolIdEditMap: { ...(details.toolIdEditMap ?? {}) },
        });
      }
    }
  }

  return result;
}
