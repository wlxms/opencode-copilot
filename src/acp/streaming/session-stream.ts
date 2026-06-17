/**
 * SerializableSessionStream (SSS) - root session stream.
 *
 * Root and sub sessions share the SessionStreamNodeBase push/update/meta flow.
 * The root stream owns workspace session directory creation and turn lifecycle.
 */

import * as vscode from 'vscode';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { buildLine } from '../serializable/serializer';
import { ensureSessionDir } from './workspace-setup';
import { SubsessionStream } from './subsession-stream';
import { SessionStreamNodeBase } from './session-stream-node';
import type { FileSnapshotRecord } from '../serializable/types';
import type { SspStream } from '../../ssp/types';

export interface SSSConfig {
  workspaceRoot: string;
  backendName: string;
  sessionId: string;
  turnIndex: number;
  requestId: string;
}

export class SerializableSessionStream extends SessionStreamNodeBase<SubsessionStream> {
  private readonly rootStream: vscode.ChatResponseStream;
  private readonly rootConfig: SSSConfig;
  private headerWritten = false;

  constructor(stream: vscode.ChatResponseStream, config: SSSConfig) {
    super(stream as unknown as SspStream, {
      turnIndex: config.turnIndex,
      requestId: config.requestId,
    }, {
      dir: null,
      streamPath: null,
      metaPath: null,
    }, '[SerializableSessionStream]');
    this.rootStream = stream;
    this.rootConfig = config;
  }

  protected createSubsession(subAgentInvocationId: string): SubsessionStream {
    return new SubsessionStream(
      this.nodeDir,
      subAgentInvocationId,
      this.rootStream as never,
      {
        turnIndex: this.rootConfig.turnIndex,
        requestId: this.rootConfig.requestId,
        subAgentPath: [subAgentInvocationId],
      },
    );
  }

  writeMeta(patch: Record<string, unknown>): void {
    if (!this.isActive) return;
    this.appendMeta({ type: 'session', ...patch });
  }

  serializeSnapshot(snapshot: FileSnapshotRecord): void {
    if (!this.isActive) return;
    const snapshotWithTurn: FileSnapshotRecord = {
      ...snapshot,
      turnIndex: snapshot.turnIndex ?? this.rootConfig.turnIndex,
    };
    this.appendStreamLine(buildLine('snapshot', snapshotWithTurn));
  }

  async initialize(): Promise<void> {
    const sessionDir = await ensureSessionDir(
      this.rootConfig.workspaceRoot,
      this.rootConfig.backendName,
      this.rootConfig.sessionId,
    );
    this.setNodePaths({
      dir: sessionDir,
      streamPath: path.join(sessionDir, 'session.jsonl'),
      metaPath: path.join(sessionDir, 'meta.jsonl'),
    });

    this.appendMeta({
      type: 'session',
      id: this.rootConfig.sessionId,
      backendName: this.rootConfig.backendName,
      createdAt: new Date().toISOString(),
    });

    const streamPath = this.getSessionPath();
    if (streamPath) {
      const hasContent = await fileHasContent(streamPath);
      if (!hasContent) {
        await fs.writeFile(streamPath, buildLine('version', '2.0'), 'utf-8');
      }
      await fs.appendFile(streamPath, buildLine('turn-start', {
        turnIndex: this.rootConfig.turnIndex,
        timestamp: new Date().toISOString(),
      }));
    }

    this.headerWritten = true;
  }

  close(): void {
    if (!this.isActive) return;
    this.deactivate();
    this.appendStreamLine(buildLine('turn-end', {
      turnIndex: this.rootConfig.turnIndex,
      timestamp: new Date().toISOString(),
    }));
  }

  async drain(): Promise<void> {
    await this.flush();
  }

  getSessionDir(): string | null { return this.nodeDir; }
  getSessionPath(): string | null { return this.streamPath; }

  protected override async beforeAppendStream(): Promise<void> {
    if (this.headerWritten || !this.streamPath) return;
    this.headerWritten = true;
    const hasContent = await fileHasContent(this.streamPath);
    if (!hasContent) {
      await fs.writeFile(this.streamPath, buildLine('version', '2.0'), 'utf-8');
    }
    await fs.appendFile(this.streamPath, buildLine('turn-start', {
      turnIndex: this.rootConfig.turnIndex,
      timestamp: new Date().toISOString(),
    }));
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
