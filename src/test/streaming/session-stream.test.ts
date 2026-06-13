/**
 * Tests for SerializableSessionStream.
 *
 * Uses temporary directories to isolate each test case, cleaning up in afterEach.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SerializableSessionStream } from '../../acp/streaming/session-stream';
import { parseLine } from '../../acp/serializable/serializer';
import { readCheckpoints } from '../../acp/checkpoint/checkpoint-store';
import type { SerializableSessionMeta, FileSnapshotRecord } from '../../acp/serializable/types';
import type { AcpEvent } from '../../acp/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStream(workspaceRoot: string): SerializableSessionStream {
  const meta: SerializableSessionMeta = {
    id: 'test-session',
    title: 'Test Session',
    createdAt: new Date().toISOString(),
  };
  return new SerializableSessionStream(workspaceRoot, 'test-backend', 'test-session', meta);
}

function makeEvent(overrides: Partial<AcpEvent> = {}): AcpEvent {
  return {
    type: 'part.updated',
    part: { id: 'p1', type: 'text', text: 'hello' },
    ...overrides,
  } as AcpEvent;
}

function makeSnapshot(editIndex: number = 1): FileSnapshotRecord {
  return {
    uri: 'file:///test.ts',
    content: `content-${editIndex}`,
    editIndex,
    toolCallId: 'tc_001',
    timestamp: new Date().toISOString(),
  };
}

/** Read all lines from a JSONL file, skipping empty lines. */
async function readLines(filePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content.split('\n').filter((l) => l.trim() !== '');
  } catch {
    return [];
  }
}

/** Parse all lines from a JSONL file into parsed objects. */
async function readParsedLines(filePath: string): Promise<unknown[]> {
  const lines = await readLines(filePath);
  return lines.map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SerializableSessionStream', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {
        /* ignore cleanup errors */
      });
    }
  });

  // 鈹€鈹€ initialize 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  it('creates session directory on initialize', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sst-init-'));
    const stream = makeStream(tmpDir);

    await stream.initialize();

    const sessionDir = path.join(tmpDir, '.acpilot', 'test-backend', 'test-session');
    const dirStat = await fs.stat(sessionDir);
    expect(dirStat.isDirectory()).toBe(true);
  });

  it('sets filePath after initialize', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sst-fp-'));
    const stream = makeStream(tmpDir);

    await stream.initialize();

    const expectedPath = path.join(
      tmpDir,
      '.acpilot',
      'test-backend',
      'test-session',
      'turns.jsonl',
    );
    // Trigger a header write so we can verify the path
    stream.onEvent(makeEvent());
    // Allow the write queue to flush
    await new Promise((r) => setTimeout(r, 50));

    const exists = await fs.stat(expectedPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it('persists external edit ids in request details metadata', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sst-edit-map-'));
    const stream = new SerializableSessionStream(
      tmpDir,
      'test-backend',
      'test-session',
      {
        id: 'test-session',
        title: 'Test Session',
        createdAt: new Date().toISOString(),
      },
      2,
      'Edit a file',
      'request-live-2',
    );

    await stream.initialize();
    stream.onExternalEdit('tool-1', 'undo-stop-1');
    stream.onExternalEdit('tool-2', 'undo-stop-2');
    await stream.flush();

    const metaPath = path.join(tmpDir, '.acpilot', 'test-backend', 'test-session', '_meta.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as SerializableSessionMeta;
    expect(meta.requestDetails).toEqual([
      {
        turnIndex: 2,
        vscodeRequestId: 'request-live-2',
        toolIdEditMap: {
          'tool-1': 'undo-stop-1',
          'tool-2': 'undo-stop-2',
        },
      },
    ]);
  });

  it('falls back to turn-index request ids when no VS Code request id is supplied', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sst-edit-map-fallback-'));
    const stream = new SerializableSessionStream(
      tmpDir,
      'test-backend',
      'test-session',
      {
        id: 'test-session',
        title: 'Test Session',
        createdAt: new Date().toISOString(),
      },
      2,
      'Edit a file',
    );

    await stream.initialize();
    stream.onExternalEdit('tool-1', 'undo-stop-1');
    await stream.flush();

    const metaPath = path.join(tmpDir, '.acpilot', 'test-backend', 'test-session', '_meta.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as SerializableSessionMeta;
    expect(meta.requestDetails).toEqual([
      {
        turnIndex: 2,
        vscodeRequestId: 'turn-2',
        toolIdEditMap: {
          'tool-1': 'undo-stop-1',
        },
      },
    ]);
  });

  it('preserves request details from earlier turns when appending a new turn', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sst-edit-map-append-'));
    const meta: SerializableSessionMeta = {
      id: 'test-session',
      title: 'Test Session',
      createdAt: new Date().toISOString(),
    };

    const first = new SerializableSessionStream(
      tmpDir,
      'test-backend',
      'test-session',
      meta,
      0,
      'First edit',
      'request-live-0',
    );
    await first.initialize();
    first.onExternalEdit('tool-0', 'undo-stop-0');
    await first.flush();

    const second = new SerializableSessionStream(
      tmpDir,
      'test-backend',
      'test-session',
      meta,
      1,
      'Second edit',
      'request-live-1',
    );
    await second.initialize();
    second.onExternalEdit('tool-1', 'undo-stop-1');
    await second.flush();

    const metaPath = path.join(tmpDir, '.acpilot', 'test-backend', 'test-session', '_meta.json');
    const persisted = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as SerializableSessionMeta;
    expect(persisted.requestDetails).toEqual([
      {
        turnIndex: 0,
        vscodeRequestId: 'request-live-0',
        toolIdEditMap: { 'tool-0': 'undo-stop-0' },
      },
      {
        turnIndex: 1,
        vscodeRequestId: 'request-live-1',
        toolIdEditMap: { 'tool-1': 'undo-stop-1' },
      },
    ]);
  });


  it('persists turn-start and turn-end records around turn events', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sst-turn-'));
    const meta: SerializableSessionMeta = {
      id: 'test-session',
      title: 'Test Session',
      createdAt: new Date().toISOString(),
    };
    const stream = new SerializableSessionStream(tmpDir, 'test-backend', 'test-session', meta, 3, 'Fix bug');

    await stream.initialize();
    stream.onEvent(makeEvent());
    stream.close();
    await stream.flush();

    const filePath = stream.getFilePath();
    expect(filePath).toBeTruthy();
    const parsed = await readParsedLines(filePath!);
    expect(parsed).toEqual(expect.arrayContaining([
      expect.objectContaining({ t: 'turn-start', d: expect.objectContaining({ turnIndex: 3, prompt: 'Fix bug' }) }),
      expect.objectContaining({ t: 'stream-part' }),
      expect.objectContaining({ t: 'turn-end', d: expect.objectContaining({ turnIndex: 3 }) }),
    ]));
  });

  it('appends later turns without rewriting existing session history', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sst-append-turn-'));
    const meta: SerializableSessionMeta = {
      id: 'test-session',
      title: 'Test Session',
      createdAt: new Date().toISOString(),
    };

    const first = new SerializableSessionStream(tmpDir, 'test-backend', 'test-session', meta, 0, 'First');
    await first.initialize();
    first.onEvent(makeEvent({ part: { id: 'p1', type: 'text', text: 'first' } } as any));
    first.close();
    await first.flush();

    const second = new SerializableSessionStream(tmpDir, 'test-backend', 'test-session', meta, 1, 'Second');
    await second.initialize();
    second.onEvent(makeEvent({ part: { id: 'p2', type: 'text', text: 'second' } } as any));
    second.close();
    await second.flush();

    const parsed = await readParsedLines(second.getFilePath()!);
    const turnStarts = parsed.filter((line: any) => line.t === 'turn-start');
    const events = parsed.filter((line: any) => line.t === 'stream-part');
    expect(turnStarts.map((line: any) => line.d.prompt)).toEqual(['First', 'Second']);
    expect(events.map((line: any) => line.d.payload.partId)).toEqual(['p1', 'p2']);
  });
  // 鈹€鈹€ onEvent 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  it('writes stream-part line to turns.jsonl by default', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sst-ev-'));
    const stream = makeStream(tmpDir);
    await stream.initialize();

    const event = makeEvent({ type: 'part.updated', part: { id: 'p1', type: 'text', text: 'hello' } });
    stream.onEvent(event);

    // Allow write queue to flush
    await new Promise((r) => setTimeout(r, 50));

    const filePath = path.join(
      tmpDir,
      '.acpilot',
      'test-backend',
      'test-session',
      'turns.jsonl',
    );
    const lines = await readParsedLines(filePath);

    // Should have version, meta, turn-start, stream-part
    expect(lines).toHaveLength(4);

    // First line is version
    expect(lines[0]).toHaveProperty('v', 2);
    expect((lines[0] as any).t).toBe('version');

    // Second line is meta
    expect(lines[1]).toHaveProperty('v', 2);
    expect((lines[1] as any).t).toBe('meta');

    // Third line is the turn start, fourth line is the stream part
    expect(lines[2]).toHaveProperty('v', 2);
    expect((lines[2] as any).t).toBe('turn-start');
    expect((lines[3] as any).t).toBe('stream-part');
    expect((lines[3] as any).d).toEqual(expect.objectContaining({
      kind: 'assistantText',
      payload: {
        partId: 'p1',
        text: 'hello',
      },
      meta: expect.objectContaining({
        turnIndex: 0,
        requestId: 'turn-0',
        sequence: 0,
        source: 'acp-event',
        sourceType: 'part.updated',
      }),
    }));
  });

  it('writes multiple events in order', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sst-me-'));
    const stream = makeStream(tmpDir);
    await stream.initialize();

    const event1 = makeEvent({ type: 'part.updated', part: { id: 'p1', type: 'text', text: 'first' } });
    const event2 = makeEvent({ type: 'session.idle' });

    stream.onEvent(event1);
    stream.onEvent(event2);
    await new Promise((r) => setTimeout(r, 50));

    const filePath = path.join(
      tmpDir,
      '.acpilot',
      'test-backend',
      'test-session',
      'turns.jsonl',
    );
    const lines = await readParsedLines(filePath);

    // version + meta + turn-start + 2 stream parts = 5
    expect(lines).toHaveLength(5);
    expect((lines[3] as any).d.kind).toBe('assistantText');
    expect((lines[3] as any).d.payload).toEqual(expect.objectContaining({ partId: 'p1', text: 'first' }));
    expect((lines[4] as any).d.kind).toBe('sessionLifecycle');
    expect((lines[4] as any).d.payload).toEqual(expect.objectContaining({ eventType: 'session.idle' }));
  });

  // 鈹€鈹€ onSnapshot 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  it('writes snapshot to both turns.jsonl and checkpoint store', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sst-ss-'));
    const stream = makeStream(tmpDir);
    await stream.initialize();

    const snapshot = makeSnapshot(0);
    stream.onSnapshot(snapshot);
    await new Promise((r) => setTimeout(r, 50));

    // Check turns.jsonl
    const turnsPath = path.join(
      tmpDir,
      '.acpilot',
      'test-backend',
      'test-session',
      'turns.jsonl',
    );
    const turnsLines = await readParsedLines(turnsPath);

    // version + meta + turn-start + snapshot = 4
    expect(turnsLines).toHaveLength(4);
    expect((turnsLines[3] as any).t).toBe('snapshot');
    expect((turnsLines[3] as any).d).toEqual(expect.objectContaining(snapshot));
    expect((turnsLines[3] as any).d.turnIndex).toBe(0);

    // Check _checkpoints.jsonl
    const sessionDir = path.join(tmpDir, '.acpilot', 'test-backend', 'test-session');
    const checkpoints = await readCheckpoints(sessionDir);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toEqual(expect.objectContaining(snapshot));
    expect(checkpoints[0].turnIndex).toBe(0);
  });

  it('writes multiple snapshots to both stores in order', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sst-ms-'));
    const stream = makeStream(tmpDir);
    await stream.initialize();

    const snap1 = makeSnapshot(0);
    const snap2 = makeSnapshot(1);
    const snap3 = makeSnapshot(2);

    stream.onSnapshot(snap1);
    stream.onSnapshot(snap2);
    stream.onSnapshot(snap3);
    await new Promise((r) => setTimeout(r, 50));

    // Check turns.jsonl 鈥?version + meta + 3 snapshots = 5
    const turnsPath = path.join(
      tmpDir,
      '.acpilot',
      'test-backend',
      'test-session',
      'turns.jsonl',
    );
    const turnsLines = await readParsedLines(turnsPath);
    expect(turnsLines).toHaveLength(6);
    expect((turnsLines[3] as any).d).toEqual(expect.objectContaining(snap1));
    expect((turnsLines[4] as any).d).toEqual(expect.objectContaining(snap2));
    expect((turnsLines[5] as any).d).toEqual(expect.objectContaining(snap3));

    // Check checkpoint store
    const sessionDir = path.join(tmpDir, '.acpilot', 'test-backend', 'test-session');
    const checkpoints = await readCheckpoints(sessionDir);
    expect(checkpoints).toHaveLength(3);
    expect(checkpoints[0]).toEqual(expect.objectContaining(snap1));
    expect(checkpoints[1]).toEqual(expect.objectContaining(snap2));
    expect(checkpoints[2]).toEqual(expect.objectContaining(snap3));
  });

  // 鈹€鈹€ onError 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  it('logs error without writing to file', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sst-er-'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stream = makeStream(tmpDir);
    await stream.initialize();

    const error = new Error('test bridge error');
    stream.onError(error);

    expect(consoleSpy).toHaveBeenCalledWith(
      '[SerializableSessionStream] Bridge error',
      error,
    );

    // initialize writes turns.jsonl with metadata and turn-start, but errors are not appended
    const turnsPath = path.join(
      tmpDir,
      '.acpilot',
      'test-backend',
      'test-session',
      'turns.jsonl',
    );
    const exists = await fs.stat(turnsPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
    const lines = await readParsedLines(turnsPath);
    expect(lines.some((line: any) => line.t === 'event' || line.t === 'stream-part')).toBe(false);

    consoleSpy.mockRestore();
  });

  // 鈹€鈹€ close 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  it('stops writing events after close', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sst-cl-'));
    const stream = makeStream(tmpDir);
    await stream.initialize();

    // Write one event, then close, then try another
    stream.onEvent(makeEvent({ type: 'part.updated', part: { id: 'p1', type: 'text', text: 'before' } }));
    stream.close();
    stream.onEvent(makeEvent({ type: 'part.updated', part: { id: 'p2', type: 'text', text: 'after' } }));
    await new Promise((r) => setTimeout(r, 50));

    const turnsPath = path.join(
      tmpDir,
      '.acpilot',
      'test-backend',
      'test-session',
      'turns.jsonl',
    );
    const lines = await readParsedLines(turnsPath);

    // version + meta + turn-start + 1 stream-part + turn-end = 5 (the after-close event should not appear)
    expect(lines).toHaveLength(5);
    expect((lines[3] as any).t).toBe('stream-part');
    expect((lines[3] as any).d.payload).toHaveProperty('partId', 'p1');
  });

  it('stops writing snapshots after close', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sst-cs-'));
    const stream = makeStream(tmpDir);
    await stream.initialize();

    stream.onSnapshot(makeSnapshot(0));
    stream.close();
    stream.onSnapshot(makeSnapshot(1));
    await new Promise((r) => setTimeout(r, 50));

    const sessionDir = path.join(tmpDir, '.acpilot', 'test-backend', 'test-session');
    const checkpoints = await readCheckpoints(sessionDir);

    // Only the snapshot written before close should exist
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].editIndex).toBe(0);
  });
});
