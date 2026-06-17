import { promises as fs } from 'node:fs';
import {
  type AnySerializableStreamPart,
  type SerializableStreamPartMeta,
  type SspStream,
  type StreamPartRecord,
  isAsyncMetadataProvider,
  isMetadataProvider,
  isMutable,
} from '../../ssp/types';
import { buildLine } from '../serializable/serializer';

export interface SessionStreamNode {
  push(ssp: AnySerializableStreamPart): void;
  update(id: string, data: Record<string, unknown>): void;
  subsession(subAgentInvocationId: string): SessionStreamNode;
  writeMeta(patch: Record<string, unknown>): void;
  has(id: string): boolean;
  flush(): Promise<void>;
}

export interface SessionStreamNodeConfig {
  turnIndex: number;
  requestId: string;
  subAgentInvocationId?: string;
  parentSubAgentInvocationId?: string;
  subAgentPath?: string[];
}

export interface SessionStreamNodePaths {
  dir: string | null;
  streamPath: string | null;
  metaPath: string | null;
}

export abstract class SessionStreamNodeBase<TChild extends SessionStreamNode>
implements SessionStreamNode {
  protected nodeDir: string | null;
  protected streamPath: string | null;
  protected metaPath: string | null;
  protected parts = new Map<string, AnySerializableStreamPart>();
  protected subsessions = new Map<string, TChild>();
  protected writeQueue: Promise<void> = Promise.resolve();
  protected sequence = 0;
  protected isActive = true;

  protected constructor(
    protected readonly stream: SspStream,
    protected readonly config: SessionStreamNodeConfig,
    paths: SessionStreamNodePaths,
    private readonly logPrefix: string,
  ) {
    this.nodeDir = paths.dir;
    this.streamPath = paths.streamPath;
    this.metaPath = paths.metaPath;
  }

  push(ssp: AnySerializableStreamPart): void {
    if (!this.isActive) return;
    this.preparePart(ssp);
    this.parts.set(ssp.id, ssp);
    ssp.onStateChange((s) => {
      this.syncMetadata(s);
    });
    ssp.render(this.stream);
    this.appendStreamRecord(ssp.toJSON());
    this.syncMetadata(ssp);
  }

  update(id: string, data: Record<string, unknown>): void {
    if (!this.isActive) return;
    const ssp = this.parts.get(id);
    if (!ssp) {
      console.warn(`${this.logPrefix} update: part ${id} not found`);
      return;
    }
    if (!isMutable(ssp)) {
      throw new Error(`${this.logPrefix} Part ${id} (kind=${ssp.kind}) is append-only, update not allowed`);
    }

    ssp.update(data);
    ssp.render(this.stream);
    this.appendStreamRecord(ssp.toJSON());
    this.syncMetadata(ssp);
  }

  subsession(subAgentInvocationId: string): TChild {
    let sub = this.subsessions.get(subAgentInvocationId);
    if (!sub) {
      sub = this.createSubsession(subAgentInvocationId);
      this.subsessions.set(subAgentInvocationId, sub);
    }
    return sub;
  }

  has(id: string): boolean {
    return this.parts.has(id);
  }

  async flush(): Promise<void> {
    await this.writeQueue;
    await this.flushAsyncMetadata();
    await this.writeQueue;
    for (const sub of this.subsessions.values()) {
      await sub.flush();
    }
  }

  abstract writeMeta(patch: Record<string, unknown>): void;

  protected abstract createSubsession(subAgentInvocationId: string): TChild;

  protected setNodePaths(paths: SessionStreamNodePaths): void {
    this.nodeDir = paths.dir;
    this.streamPath = paths.streamPath;
    this.metaPath = paths.metaPath;
  }

  protected deactivate(): void {
    this.isActive = false;
  }

  protected appendMeta(data: Record<string, unknown>): void {
    this.enqueueWrite(async () => {
      if (!this.metaPath) return;
      await fs.appendFile(this.metaPath, JSON.stringify({ v: 2, ...data }) + '\n');
    });
  }

  protected appendStreamLine(line: string): void {
    this.enqueueWrite(async () => {
      if (!this.streamPath) return;
      await this.beforeAppendStream();
      await fs.appendFile(this.streamPath, line);
    });
  }

  protected enqueueWrite(fn: () => Promise<void>): void {
    this.writeQueue = this.writeQueue.then(fn).catch(err => {
      console.error(`${this.logPrefix} Write error`, err);
    });
  }

  protected beforeAppendStream(): Promise<void> | void {
    return undefined;
  }

  protected preparePart(ssp: AnySerializableStreamPart): void {
    const meta = ssp.meta as SerializableStreamPartMeta;
    meta.turnIndex = this.config.turnIndex;
    meta.requestId = this.config.requestId;
    meta.sequence = this.sequence++;
    meta.createdAt = meta.createdAt || new Date().toISOString();
    meta.source = meta.source || 'acp-event';
    meta.subAgentInvocationId = meta.subAgentInvocationId ?? this.config.subAgentInvocationId;
    meta.parentSubAgentInvocationId = meta.parentSubAgentInvocationId ?? this.config.parentSubAgentInvocationId;
    meta.subAgentPath = meta.subAgentPath ?? this.config.subAgentPath;

    if (this.config.subAgentInvocationId) {
      const payload = ssp.payload as Record<string, unknown>;
      if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.subAgentInvocationId === undefined) {
        payload.subAgentInvocationId = this.config.subAgentInvocationId;
      }
    }
  }

  private appendStreamRecord(record: StreamPartRecord): void {
    this.appendStreamLine(buildLine('stream-part', record));
  }

  private syncMetadata(ssp: AnySerializableStreamPart): void {
    if (!isMetadataProvider(ssp)) return;
    const meta = ssp.getMetadata();
    if (!meta) return;
    this.appendMeta({ type: 'part-meta', id: ssp.metaId, ...meta });
  }

  private async flushAsyncMetadata(): Promise<void> {
    const pending = [...this.parts.values()]
      .filter(isAsyncMetadataProvider)
      .map(part => part.whenMetadataSettled());
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }
}
