/**
 * SubsessionStream — push/update API for child session (subagent) stream parts.
 *
 * Writes to: {sessionDir}/subsessions/{subAgentInvocationId}/subsession.jsonl
 *
 * Same push/update API as SerializableSessionStream but writes to a separate
 * file so parent and child events don't interleave in session.jsonl.
 *
 * Directory structure supports recursive nesting for nested subagents.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  type AnySerializableStreamPart,
  type SspStream,
  type StreamPartRecord,
  isMutable,
} from '../../ssp/types';
import { buildLine } from '../serializable/serializer';

export class SubsessionStream {
  private parts = new Map<string, AnySerializableStreamPart>();
  private filePath: string;
  private subDir: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    sessionDir: string,
    subAgentInvocationId: string,
    private readonly stream: SspStream,
  ) {
    this.subDir = path.join(sessionDir, 'subsessions', subAgentInvocationId);
    this.filePath = path.join(this.subDir, 'subsession.jsonl');
  }

  /** Push a new SSP — renders to stream, appends to subsession.jsonl */
  push(ssp: AnySerializableStreamPart): void {
    this.parts.set(ssp.id, ssp);
    ssp.render(this.stream);
    this.append(ssp.toJSON());
  }

  /** Update an existing mutable SSP — merge, render, append */
  update(id: string, data: Record<string, unknown>): void {
    const ssp = this.parts.get(id);
    if (!ssp || !isMutable(ssp)) return;
    ssp.update(data);
    ssp.render(this.stream);
    this.append(ssp.toJSON());
  }

  /** Get the subsession directory (for nested subsessions) */
  getSubDir(): string { return this.subDir; }

  /** Wait for all pending writes */
  async flush(): Promise<void> { await this.writeQueue; }

  private append(record: StreamPartRecord): void {
    this.enqueueWrite(async () => {
      await fs.mkdir(this.subDir, { recursive: true });
      await fs.appendFile(this.filePath, buildLine('stream-part', record));
    });
  }

  private enqueueWrite(fn: () => Promise<void>): void {
    this.writeQueue = this.writeQueue.then(fn).catch(err => {
      console.error('[SubsessionStream] Write error', err);
    });
  }
}
