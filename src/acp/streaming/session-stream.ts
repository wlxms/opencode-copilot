/**
 * SerializableSessionStream — persists ACP events and file snapshots to JSONL.
 *
 * This replaces the v1 approach of serialising `SerializablePart` arrays with
 * a v2 approach that writes raw `AcpEvent` lines and delegates snapshot storage
 * to the checkpoint store. Turn-start/turn-end markers are removed — events are
 * the fundamental persistence unit.
 *
 * Layout per session:
 *   {workspaceRoot}/.acpilot/{backendName}/{sessionId}/
 *     turns.jsonl          — event stream + inline snapshots (v2 JSONL)
 *     _checkpoints.jsonl   — dedicated checkpoint-store file
 */

import path from 'node:path';
import { ensureSessionDir } from './workspace-setup';
import {
  writeVersionHeader,
  writeMeta,
  writeEvent,
  writeSnapshotLine,
} from '../serializable/serializer';
import { writeSnapshot } from '../checkpoint/checkpoint-store';
import type { StreamingBridgeCallbacks } from '../../acp/backend';
import type { SerializableSessionMeta, FileSnapshotRecord } from '../serializable/types';
import type { AcpEvent } from '../types';

const LOG_PREFIX = '[SerializableSessionStream]';

export class SerializableSessionStream implements StreamingBridgeCallbacks {
  private filePath: string | null = null;
  private sessionDir: string | null = null;
  private headerWritten = false;
  private isActive = true;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly workspaceRoot: string,
    private readonly backendName: string,
    private readonly sessionId: string,
    private readonly meta: SerializableSessionMeta,
  ) {}

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
    await writeVersionHeader(this.filePath);
    await writeMeta(this.filePath, this.meta as unknown as Record<string, unknown>);
    this.headerWritten = true;
  }

  /**
   * Gracefully shut down the stream. Subsequent onEvent/onSnapshot calls
   * become no-ops.
   */
  close(): void {
    this.isActive = false;
  }

  /** Get the JSONL file path (for diagnostics) */
  getFilePath(): string | null {
    return this.filePath;
  }

  // ── Callbacks ─────────────────────────────────────────────────────────

  /**
   * Persist an ACP event as a JSONL line.
   * Replaces the v1 `onPartComplete` — entire events are written, not parts.
   */
  onEvent(event: AcpEvent): void {
    if (!this.isActive) return;
    this.enqueueWrite(async () => {
      if (!this.filePath) return;
      await this.ensureHeader();
      await writeEvent(this.filePath, event);
    });
  }

  /**
   * Persist a file snapshot — both inline in `turns.jsonl` (for chronological
   * replay) and to the dedicated checkpoint store for structural access.
   */
  onSnapshot(snapshot: FileSnapshotRecord): void {
    if (!this.isActive) return;
    this.enqueueWrite(async () => {
      if (!this.filePath || !this.sessionDir) return;
      await this.ensureHeader();
      // Write inline to turns.jsonl for chronological replay
      await writeSnapshotLine(this.filePath, snapshot);
      // Write to checkpoint store (_checkpoints.jsonl) for structural access
      await writeSnapshot(this.sessionDir, snapshot);
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
    await writeVersionHeader(this.filePath);
    await writeMeta(this.filePath, this.meta as unknown as Record<string, unknown>);
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
}
