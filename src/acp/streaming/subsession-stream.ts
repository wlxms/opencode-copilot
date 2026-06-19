/**
 * SubsessionStream - semantic stream node for a subagent session.
 *
 * It shares push/update/meta behavior with the root SSS via SessionStreamNodeBase,
 * but owns subagent-specific paths and ancestry metadata.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { AnySerializableStreamPart, SspStream } from '../../ssp/types';
import { SessionStreamNodeBase } from './session-stream-node';
import type { SessionStreamNodeConfig } from './session-stream-node';

export interface SubsessionStreamConfig {
  turnIndex: number;
  requestId: string;
  parentSubAgentInvocationId?: string;
  subAgentPath?: string[];
}

export class SubsessionStream extends SessionStreamNodeBase<SubsessionStream> {
  private readonly subDir: string | null;

  constructor(
    parentDir: string | null,
    private readonly subAgentInvocationId: string,
    stream: SspStream,
    config: SubsessionStreamConfig,
  ) {
    const subAgentPath = config.subAgentPath ?? [subAgentInvocationId];
    const nodeConfig: SessionStreamNodeConfig = {
      turnIndex: config.turnIndex,
      requestId: config.requestId,
      subAgentInvocationId,
      parentSubAgentInvocationId: config.parentSubAgentInvocationId,
      subAgentPath,
    };
    const subDir = parentDir ? path.join(parentDir, 'subsessions', subAgentInvocationId) : null;
    super(stream, nodeConfig, {
      dir: subDir,
      streamPath: subDir ? path.join(subDir, 'subsession.jsonl') : null,
      metaPath: subDir ? path.join(subDir, 'meta.jsonl') : null,
    }, '[SubsessionStream]');
    this.subDir = subDir;
  }

  getSubDir(): string { return this.subDir ?? ''; }

  writeMeta(patch: Record<string, unknown>): void {
    if (!this.isActive) return;
    this.appendMeta({ type: 'session', ...patch });
  }

  protected createSubsession(subAgentInvocationId: string): SubsessionStream {
    return new SubsessionStream(
      this.subDir,
      subAgentInvocationId,
      this.stream,
      {
        turnIndex: this.config.turnIndex,
        requestId: this.config.requestId,
        parentSubAgentInvocationId: this.subAgentInvocationId,
        subAgentPath: [...(this.config.subAgentPath ?? [this.subAgentInvocationId]), subAgentInvocationId],
      },
    );
  }

  protected override async beforeAppendStream(): Promise<void> {
    if (this.subDir) {
      await fs.mkdir(this.subDir, { recursive: true });
    }
  }

  protected override shouldRender(ssp: AnySerializableStreamPart): boolean {
    return ssp.kind !== 'assistantText' && ssp.kind !== 'reasoning';
  }

  protected override appendMeta(data: Record<string, unknown>): void {
    this.enqueueWrite(async () => {
      if (!this.subDir || !this.metaPath) return;
      await fs.mkdir(this.subDir, { recursive: true });
      await fs.appendFile(this.metaPath, JSON.stringify({ v: 2, ...data }) + '\n');
    });
  }
}
