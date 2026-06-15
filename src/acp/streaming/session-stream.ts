/**
 * SerializableSessionStream (SSS) — owns the VS Code stream, provides push/update API.
 *
 * Architecture (v2):
 * - SSS holds the vscode.ChatResponseStream — Bridge does NOT touch it directly
 * - push(ssp): render to stream + append to session.jsonl + syncMetadata
 * - update(id, data): merge mutable part + render + append + syncMetadata
 * - subsession(id): returns SubsessionStream for child session events
 * - writeMeta(patch): append session-level metadata to meta.jsonl
 * - syncMetadata(ssp): collect IMetadataProvider data → meta.jsonl
 *
 * File layout:
 *   {workspaceRoot}/.acpilot/{backendName}/{sessionId}/
 *     session.jsonl     ← stream parts (pure append, never rewritten)
 *     meta.jsonl        ← metadata (pure append, last-write-wins per id)
 *     subsessions/      ← child session files (SubsessionStream)
 *
 * Serialization strategy: write without merge, read with merge (materializeRecords).
 */

import * as vscode from 'vscode';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  type AnySerializableStreamPart,
  type StreamPartRecord,
  type SspStream,
  isMutable,
  isMetadataProvider,
} from '../../ssp/types';
import { buildLine } from '../serializable/serializer';
import { ensureSessionDir } from './workspace-setup';
import { SubsessionStream } from './subsession-stream';
import type { FileSnapshotRecord } from '../serializable/types';

const LOG_PREFIX = '[SerializableSessionStream]';

export interface SSSConfig {
  workspaceRoot: string;
  backendName: string;
  sessionId: string;
  turnIndex: number;
  requestId: string;
}

export class SerializableSessionStream {
  private readonly stream: vscode.ChatResponseStream;
  private readonly config: SSSConfig;

  private sessionDir: string | null = null;
  private sessionPath: string | null = null;
  private metaPath: string | null = null;
  private headerWritten = false;
  private isActive = true;

  private parts = new Map<string, AnySerializableStreamPart>();
  private subsessions = new Map<string, SubsessionStream>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(stream: vscode.ChatResponseStream, config: SSSConfig) {
    this.stream = stream;
    this.config = config;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Core API: push / update
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Push a new SSP to the stream.
   * Renders immediately, appends to session.jsonl, collects metadata.
   */
  push(ssp: AnySerializableStreamPart): void {
    if (!this.isActive) return;
    this.parts.set(ssp.id, ssp);

    // Subscribe to async state changes (only fires for SSP-internal async events)
    // Plan: async SSP-internal changes (questionCarousel answer, externalEdit undoStopId)
    // should only sync metadata to meta.jsonl, not re-render or append to session.jsonl.
    ssp.onStateChange((s) => {
      this.syncMetadata(s);
    });

    ssp.render(this.stream as unknown as SspStream);
    this.appendSession(ssp.toJSON());
    this.syncMetadata(ssp);
  }

  /**
   * Update an existing mutable SSP.
   * Merges data, re-renders, appends updated record to session.jsonl.
   * Throws if the part is append-only (does not implement IMutableStreamPart).
   */
  update(id: string, data: Record<string, unknown>): void {
    if (!this.isActive) return;
    const ssp = this.parts.get(id);
    if (!ssp) {
      console.warn(`${LOG_PREFIX} update: part ${id} not found`);
      return;
    }
    if (!isMutable(ssp)) {
      throw new Error(`${LOG_PREFIX} Part ${id} (kind=${ssp.kind}) is append-only, update not allowed`);
    }

    ssp.update(data);
    ssp.render(this.stream as unknown as SspStream);
    this.appendSession(ssp.toJSON());
    this.syncMetadata(ssp);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Subsession API
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Get or create a SubsessionStream for child session events.
   * Child events are written to a separate file to avoid interleaving.
   */
  subsession(subAgentInvocationId: string): SubsessionStream {
    let sub = this.subsessions.get(subAgentInvocationId);
    if (!sub) {
      if (!this.sessionDir) {
        throw new Error(`${LOG_PREFIX} Cannot create subsession before initialize()`);
      }
      sub = new SubsessionStream(
        this.sessionDir,
        subAgentInvocationId,
        this.stream as unknown as SspStream,
      );
      this.subsessions.set(subAgentInvocationId, sub);
    }
    return sub;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Metadata API
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Write session-level metadata (title, status, etc.) to meta.jsonl.
   * Called by Bridge on session.updated / session.idle / session.diff events.
   */
  writeMeta(patch: Record<string, unknown>): void {
    if (!this.isActive) return;
    this.appendMeta({ type: 'session', ...patch });
  }

  /**
   * Collect metadata from an SSP via IMetadataProvider and write to meta.jsonl.
   * Called after push/update and on async state change.
   */
  private syncMetadata(ssp: AnySerializableStreamPart): void {
    if (!isMetadataProvider(ssp)) return;
    const meta = ssp.getMetadata();
    if (!meta) return;
    this.appendMeta({ type: 'part-meta', id: ssp.metaId, ...meta });
  }

  // ════════════════════════════════════════════════════════════════════════
  // Snapshot API
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Serialize a file snapshot to session.jsonl.
   * Called by ExternalEditSSP callbacks (onSnapshot).
   */
  serializeSnapshot(snapshot: FileSnapshotRecord): void {
    if (!this.isActive) return;
    const snapshotWithTurn: FileSnapshotRecord = {
      ...snapshot,
      turnIndex: snapshot.turnIndex ?? this.config.turnIndex,
    };
    this.enqueueWrite(async () => {
      if (!this.sessionPath) return;
      await this.ensureHeader();
      await fs.appendFile(this.sessionPath, buildLine('snapshot', snapshotWithTurn));
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Initialize session directory and write version header + turn-start.
   * Must be called once before any push/update calls.
   */
  async initialize(): Promise<void> {
    const sessionDir = await ensureSessionDir(
      this.config.workspaceRoot,
      this.config.backendName,
      this.config.sessionId,
    );
    this.sessionDir = sessionDir;
    this.sessionPath = path.join(sessionDir, 'session.jsonl');
    this.metaPath = path.join(sessionDir, 'meta.jsonl');

    // Write initial session metadata
    this.appendMeta({
      type: 'session',
      id: this.config.sessionId,
      backendName: this.config.backendName,
      createdAt: new Date().toISOString(),
    });

    // Write version header if new file
    const hasContent = await fileHasContent(this.sessionPath);
    if (!hasContent) {
      await fs.writeFile(this.sessionPath, buildLine('version', '2.0'), 'utf-8');
    }

    // Write turn-start
    await fs.appendFile(this.sessionPath, buildLine('turn-start', {
      turnIndex: this.config.turnIndex,
      timestamp: new Date().toISOString(),
    }));

    this.headerWritten = true;
  }

  /**
   * Close the stream — writes turn-end. Subsequent push/update calls become no-ops.
   */
  close(): void {
    if (!this.isActive) return;
    this.isActive = false;
    this.enqueueWrite(async () => {
      if (!this.sessionPath) return;
      await this.ensureHeader();
      await fs.appendFile(this.sessionPath, buildLine('turn-end', {
        turnIndex: this.config.turnIndex,
        timestamp: new Date().toISOString(),
      }));
    });
  }

  /** Wait for all pending writes to session.jsonl + meta.jsonl */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  /**
   * Drain: flush main session + all subsessions.
   * Called by handler in finally block to ensure all async writes complete.
   */
  async drain(): Promise<void> {
    for (const sub of this.subsessions.values()) {
      await sub.flush();
    }
    await this.flush();
  }

  /** Get session directory path (for diagnostics and subsession access) */
  getSessionDir(): string | null { return this.sessionDir; }
  /** Get session.jsonl path (for diagnostics) */
  getSessionPath(): string | null { return this.sessionPath; }

  // ════════════════════════════════════════════════════════════════════════
  // Internal: file I/O
  // ════════════════════════════════════════════════════════════════════════

  private appendSession(record: StreamPartRecord): void {
    // Serialize NOW (synchronous) to capture payload state at this moment.
    // toJSON() returns a reference to this.payload, so deferring serialization
    // would capture the mutated state (e.g. after update changes status).
    const line = buildLine('stream-part', record);
    this.enqueueWrite(async () => {
      if (!this.sessionPath) return;
      await this.ensureHeader();
      await fs.appendFile(this.sessionPath, line);
    });
  }

  private appendMeta(data: Record<string, unknown>): void {
    this.enqueueWrite(async () => {
      if (!this.metaPath) return;
      await fs.appendFile(this.metaPath, JSON.stringify({ v: 2, ...data }) + '\n');
    });
  }

  private async ensureHeader(): Promise<void> {
    if (this.headerWritten || !this.sessionPath) return;
    this.headerWritten = true;
    const hasContent = await fileHasContent(this.sessionPath);
    if (!hasContent) {
      await fs.writeFile(this.sessionPath, buildLine('version', '2.0'), 'utf-8');
    }
    await fs.appendFile(this.sessionPath, buildLine('turn-start', {
      turnIndex: this.config.turnIndex,
      timestamp: new Date().toISOString(),
    }));
  }

  private enqueueWrite(fn: () => Promise<void>): void {
    this.writeQueue = this.writeQueue.then(fn).catch(err => {
      console.error(`${LOG_PREFIX} Write error`, err);
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

async function fileHasContent(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.size > 0;
  } catch {
    return false;
  }
}
