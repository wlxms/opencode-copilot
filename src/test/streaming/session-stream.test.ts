/**
 * Tests for SerializableSessionStream (v2: push/update API).
 *
 * Uses temporary directories to isolate each test case.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SerializableSessionStream } from '../../acp/streaming/session-stream';
import { materializeRecords, finalizeIncompleteStates } from '../../acp/streaming/deserialize';
import { readAllStreamParts, readMetaIndex, createSSPFromRecord } from '../../acp/streaming/deserialize';
import { AssistantTextSSP } from '../../ssp/impl/assistant-text';
import { ReasoningSSP } from '../../ssp/impl/reasoning';
import { ToolInvocationSSP } from '../../ssp/impl/tool-invocation';
import { UserPromptSSP } from '../../ssp/impl/user-prompt';
import type { StreamPartRecord, SerializableToolState } from '../../ssp/types';
import type { FileSnapshotRecord } from '../../acp/serializable/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockStream() {
  return {
    markdown: vi.fn(),
    progress: vi.fn(),
    push: vi.fn(),
    thinkingProgress: vi.fn(),
    beginToolInvocation: vi.fn(),
    updateToolInvocation: vi.fn(),
  };
}

function makeSSS(tmpDir: string, overrides?: { turnIndex?: number }) {
  return new SerializableSessionStream(mockStream() as any, {
    workspaceRoot: tmpDir,
    backendName: 'test-backend',
    sessionId: 'test-session',
    turnIndex: overrides?.turnIndex ?? 0,
    requestId: 'req-0',
  });
}

function toolState(overrides?: Partial<SerializableToolState>): SerializableToolState {
  return { status: 'pending', input: {}, ...overrides };
}

function getSessionDir(tmpDir: string): string {
  return path.join(tmpDir, '.acpilot', 'test-backend', 'test-session');
}

async function readLines(filePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content.split('\n').filter(l => l.trim() !== '');
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// SerializableSessionStream
// ---------------------------------------------------------------------------

describe('SerializableSessionStream', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ── initialize ─────────────────────────────────────────────────────────

  it('creates session directory on initialize', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-init-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();
    const stat = await fs.stat(getSessionDir(tmpDir));
    expect(stat.isDirectory()).toBe(true);
  });

  it('writes version + turn-start to session.jsonl on initialize', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-ver-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();
    await sss.flush();

    const lines = await readLines(path.join(getSessionDir(tmpDir), 'session.jsonl'));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const first = JSON.parse(lines[0]);
    expect(first.t).toBe('version');
    const second = JSON.parse(lines[1]);
    expect(second.t).toBe('turn-start');
  });

  it('writes initial session meta to meta.jsonl on initialize', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-meta-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();
    await sss.flush();

    const lines = await readLines(path.join(getSessionDir(tmpDir), 'meta.jsonl'));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const meta = JSON.parse(lines[0]);
    expect(meta.type).toBe('session');
    expect(meta.backendName).toBe('test-backend');
  });

  // ── push ───────────────────────────────────────────────────────────────

  it('push renders to stream and appends to session.jsonl', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-push-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();

    sss.push(new ReasoningSSP({ partId: 'r1', delta: 'thinking...' }));
    await sss.flush();

    const parts = await readAllStreamParts(path.join(getSessionDir(tmpDir), 'session.jsonl'));
    expect(parts.length).toBe(1);
    expect(parts[0].kind).toBe('reasoning');
    expect((parts[0].payload as { text: string }).text).toBe('thinking...');
  });

  it('push user prompt', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-prompt-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();

    sss.push(new UserPromptSSP({ text: 'hello world', partId: 'u1' }));
    await sss.flush();

    const parts = await readAllStreamParts(path.join(getSessionDir(tmpDir), 'session.jsonl'));
    expect(parts.some(p => p.kind === 'userPrompt')).toBe(true);
  });

  // ── update ─────────────────────────────────────────────────────────────

  it('update merges mutable part and appends', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-update-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();

    const toolSSP = new ToolInvocationSSP({
      partId: 't1', toolName: 'bash', callId: 'c1',
      state: toolState({ status: 'pending', input: {} }),
    });
    sss.push(toolSSP);
    sss.update(toolSSP.id, { state: toolState({ status: 'completed', output: 'done' }) });
    await sss.flush();

    const parts = await readAllStreamParts(path.join(getSessionDir(tmpDir), 'session.jsonl'));
    expect(parts.length).toBe(2); // push + update = 2 lines
    expect((parts[0].payload as { state: { status: string } }).state.status).toBe('pending');
    expect((parts[1].payload as { state: { status: string } }).state.status).toBe('completed');
  });

  // ── writeMeta ──────────────────────────────────────────────────────────

  it('writeMeta appends to meta.jsonl', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-wm-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();

    sss.writeMeta({ title: 'New Title', status: 'completed' });
    await sss.flush();

    const metaIndex = await readMetaIndex(path.join(getSessionDir(tmpDir), 'meta.jsonl'));
    const session = metaIndex.get('session');
    expect(session?.title).toBe('New Title');
    expect(session?.status).toBe('completed');
  });

  // ── close ──────────────────────────────────────────────────────────────

  it('close writes turn-end to session.jsonl', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-close-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();
    sss.close();
    await sss.flush();

    const lines = await readLines(path.join(getSessionDir(tmpDir), 'session.jsonl'));
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.t).toBe('turn-end');
  });

  // ── subsession ─────────────────────────────────────────────────────────

  it('subsession creates SubsessionStream that writes to separate file', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-sub-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();

    const sub = sss.subsession('sub-invocation-1');
    sub.push(new ToolInvocationSSP({
      partId: 'child-1', toolName: 'read', callId: 'child-c1',
      state: toolState({ status: 'completed', input: {}, output: 'content' }),
      subAgentInvocationId: 'sub-invocation-1',
    }));
    await sub.flush();

    const subPath = path.join(getSessionDir(tmpDir), 'subsessions', 'sub-invocation-1', 'subsession.jsonl');
    const parts = await readAllStreamParts(subPath);
    expect(parts.length).toBe(1);
    expect(parts[0].kind).toBe('toolInvocation');
  });

  // ── serializeSnapshot ──────────────────────────────────────────────────

  it('serializeSnapshot writes snapshot line to session.jsonl', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-snap-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();

    const snapshot: FileSnapshotRecord = {
      uri: 'file:///test.ts',
      content: 'file content',
      phase: 'before',
      editIndex: 0,
      toolCallId: 'tc1',
      timestamp: new Date().toISOString(),
    };
    sss.serializeSnapshot(snapshot);
    await sss.flush();

    const lines = await readLines(path.join(getSessionDir(tmpDir), 'session.jsonl'));
    const snapshotLines = lines.filter(l => JSON.parse(l).t === 'snapshot');
    expect(snapshotLines.length).toBe(1);
  });

  // ── drain ──────────────────────────────────────────────────────────────

  it('drain flushes main session and all subsessions', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-drain-'));
    const sss = makeSSS(tmpDir);
    await sss.initialize();

    sss.push(new AssistantTextSSP({ partId: 't1', delta: 'text' }));
    const sub = sss.subsession('sub-1');
    sub.push(new ToolInvocationSSP({
      partId: 'c1', toolName: 'read', callId: 'cc1',
      state: toolState({ status: 'completed' }),
    }));

    await sss.drain();

    const mainParts = await readAllStreamParts(path.join(getSessionDir(tmpDir), 'session.jsonl'));
    const subParts = await readAllStreamParts(
      path.join(getSessionDir(tmpDir), 'subsessions', 'sub-1', 'subsession.jsonl'),
    );
    expect(mainParts.length).toBeGreaterThanOrEqual(1);
    expect(subParts.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// materializeRecords
// ---------------------------------------------------------------------------

describe('materializeRecords', () => {
  function rec(id: string, kind: string, payload: Record<string, unknown>): StreamPartRecord {
    return { kind, version: 1, id, payload, meta: { turnIndex: 0, requestId: '', sequence: 0, createdAt: '', source: 'restore' } };
  }

  it('merges consecutive append-only records by concatenating text', () => {
    const records = [
      rec('r1', 'reasoning', { partId: 'r1', text: 'Hello' }),
      rec('r1', 'reasoning', { partId: 'r1', text: ' world' }),
    ];
    const result = materializeRecords(records);
    expect(result.length).toBe(1);
    expect((result[0].payload as { text: string }).text).toBe('Hello world');
  });

  it('does NOT merge append-only records interrupted by different id', () => {
    const records = [
      rec('r1', 'reasoning', { partId: 'r1', text: 'A' }),
      rec('t1', 'toolInvocation', { partId: 't1', state: { status: 'completed' } }),
      rec('r1', 'reasoning', { partId: 'r1', text: 'B' }),
    ];
    const result = materializeRecords(records);
    expect(result.length).toBe(3); // r1, t1, r1 (separate)
  });

  it('globally aggregates mutable records by id even if non-consecutive', () => {
    const records = [
      rec('t1', 'toolInvocation', { partId: 't1', state: { status: 'pending', input: {} } }),
      rec('r1', 'reasoning', { partId: 'r1', text: 'interrupting' }),
      rec('t1', 'toolInvocation', { partId: 't1', state: { status: 'completed', output: 'done' } }),
    ];
    const result = materializeRecords(records);
    expect(result.length).toBe(2); // t1 (aggregated) + r1
    const toolRecord = result.find(r => r.kind === 'toolInvocation')!;
    expect((toolRecord.payload as { state: { status: string } }).state.status).toBe('completed');
  });

  it('preserves error as terminal state in tool merge', () => {
    const records = [
      rec('t1', 'toolInvocation', { partId: 't1', state: { status: 'error', error: 'Failed', input: {} } }),
      rec('t1', 'toolInvocation', { partId: 't1', state: { status: 'completed', output: 'done', input: {} } }),
    ];
    const result = materializeRecords(records);
    expect(result.length).toBe(1);
    expect((result[0].payload as { state: { status: string } }).state.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// finalizeIncompleteStates
// ---------------------------------------------------------------------------

describe('finalizeIncompleteStates', () => {
  function rec(kind: string, payload: Record<string, unknown>): StreamPartRecord {
    return { kind, version: 1, id: 'test', payload, meta: { turnIndex: 0, requestId: '', sequence: 0, createdAt: '', source: 'restore' } };
  }

  it('marks pending tools as error in completed sessions', () => {
    const records = [rec('toolInvocation', { state: { status: 'pending', input: {} } })];
    const result = finalizeIncompleteStates(records, 'completed');
    expect((result[0].payload as { state: { status: string } }).state.status).toBe('error');
  });

  it('marks running tools as error in completed sessions', () => {
    const records = [rec('toolInvocation', { state: { status: 'running', input: {} } })];
    const result = finalizeIncompleteStates(records, 'completed');
    expect((result[0].payload as { state: { status: string } }).state.status).toBe('error');
  });

  it('does NOT touch pending tools in inProgress sessions', () => {
    const records = [rec('toolInvocation', { state: { status: 'pending', input: {} } })];
    const result = finalizeIncompleteStates(records, 'inProgress');
    expect((result[0].payload as { state: { status: string } }).state.status).toBe('pending');
  });

  it('does NOT touch completed tools', () => {
    const records = [rec('toolInvocation', { state: { status: 'completed', input: {} } })];
    const result = finalizeIncompleteStates(records, 'completed');
    expect((result[0].payload as { state: { status: string } }).state.status).toBe('completed');
  });

  it('marks asked questions as skipped in completed sessions', () => {
    const records = [rec('question', { questionId: 'q1', questions: [], status: 'asked' })];
    const result = finalizeIncompleteStates(records, 'completed');
    expect((result[0].payload as { status: string }).status).toBe('skipped');
  });
});

// ---------------------------------------------------------------------------
// createSSPFromRecord
// ---------------------------------------------------------------------------

describe('createSSPFromRecord', () => {
  it('creates AssistantTextSSP from assistantText record', () => {
    const record: StreamPartRecord = {
      kind: 'assistantText', version: 1, id: 'ssp-1',
      payload: { partId: 'a1', text: 'hello' },
      meta: { turnIndex: 0, requestId: '', sequence: 0, createdAt: '', source: 'restore' },
    };
    const ssp = createSSPFromRecord(record);
    expect(ssp.kind).toBe('assistantText');
    expect((ssp.payload as { text: string }).text).toBe('hello');
  });

  it('creates ToolInvocationSSP from toolInvocation record', () => {
    const record: StreamPartRecord = {
      kind: 'toolInvocation', version: 1, id: 'ssp-2',
      payload: { partId: 't1', toolName: 'bash', callId: 'c1', state: { status: 'completed', input: {} } },
      meta: { turnIndex: 0, requestId: '', sequence: 0, createdAt: '', source: 'restore' },
    };
    const ssp = createSSPFromRecord(record);
    expect(ssp.kind).toBe('toolInvocation');
    expect((ssp.payload as { toolName: string }).toolName).toBe('bash');
  });

  it('creates ExternalEditSSP with undoStopId from meta', () => {
    const record: StreamPartRecord = {
      kind: 'externalEdit', version: 1, id: 'ssp-3',
      payload: { toolCallId: 'c1', editId: '', status: 'completed' },
      meta: { turnIndex: 0, requestId: '', sequence: 0, createdAt: '', source: 'restore' },
    };
    const metaIndex = new Map([['ssp-3', { undoStopId: 'undo-xxx' }]]);
    const ssp = createSSPFromRecord(record, metaIndex);
    expect(ssp.kind).toBe('externalEdit');
    expect((ssp.payload as { undoStopId?: string }).undoStopId).toBe('undo-xxx');
  });
});
