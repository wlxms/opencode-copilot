/** E2E: Backend start → mock events → JSONL roundtrip → replay via bridge */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import 'vscode';
import { registerBackend, createBackend } from '../../acp/backend-registry';
import { OpenCodeBackend } from '../../backends/opencode/adapter';
import { CollectorStream } from '../../acp/streaming/collector-stream';
import { readSessionEvents, writeVersionHeader, writeMeta, writeEvent } from '../../acp/serializable/serializer';
import type { SerializableSessionMeta } from '../../acp/serializable/types';
import type { AcpBackend } from '../../acp/backend';

registerBackend('opencode', () => new OpenCodeBackend());

const MOCK_EVENTS: any[] = [
  { type: 'part.updated', part: { type: 'text', id: 'pt1', text: 'Hello from E2E' } },
  { type: 'part.updated', part: { type: 'reasoning', id: 'pr1', text: 'Let me think...' } },
  { type: 'part.updated', part: { type: 'tool', id: 'pb1', toolName: 'read', callId: 'call-r', state: { status: 'pending', input: { filePath: 'hello.ts' }, title: 'read' } } },
  { type: 'part.updated', part: { type: 'tool', id: 'pb1', toolName: 'read', callId: 'call-r', state: { status: 'running', input: { filePath: 'hello.ts' }, title: 'read' } } },
  { type: 'part.updated', part: { type: 'tool', id: 'pb1', toolName: 'read', callId: 'call-r', state: { status: 'completed', input: { filePath: 'hello.ts' }, output: 'console.log("hello")', title: 'read', startTime: 100, endTime: 200 } } },
  { type: 'part.updated', part: { type: 'text', id: 'pt2', text: 'This prints hello' } },
  { type: 'session.diff', diffs: [{ uri: 'hello.ts', original: '', modified: 'new' }] },
  { type: 'session.idle', sessionId: 'test' },
];

describe('E2E JSONL Roundtrip', () => {
  let backend: AcpBackend;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-e2e-'));
    await fs.mkdir(path.join(tempDir, 'ws'), { recursive: true });
    backend = createBackend('opencode');
    await backend.start(path.join(tempDir, 'ws')).catch(() => {});
  }, 30000);

  afterAll(async () => {
    try { await backend.stop(); } catch {}
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('serialize → JSONL → deserialize → replay via bridge', async () => {
    const sid = 'ses_e2e_test';
    const sessionDir = path.join(tempDir, '.acpilot', 'opencode', sid);
    await fs.mkdir(sessionDir, { recursive: true });
    const turnsPath = path.join(sessionDir, 'turns.jsonl');

    // ── WRITE ──
    const meta: SerializableSessionMeta = { id: sid, title: 'E2E', createdAt: new Date().toISOString(), backendName: 'opencode' };
    await writeVersionHeader(turnsPath);
    await writeMeta(turnsPath, meta);
    await writeEvent(turnsPath, { type: 'part.updated', part: { type: 'text', id: 'user', text: 'Read hello.ts' } } as any);
    for (const evt of MOCK_EVENTS) await writeEvent(turnsPath, evt);

    console.log(`[E2E] Wrote ${MOCK_EVENTS.length + 1} events`);

    // ── READ ──
    const events = await readSessionEvents(turnsPath);
    console.log(`[E2E] Read ${events.length} events back`);
    expect(events.length).toBe(MOCK_EVENTS.length + 1);
    expect(events.map(e => e.type)).toContain('session.idle');

    const tool = events.find(e => e.type === 'part.updated' && (e as any).part?.type === 'tool') as any;
    expect(tool).toBeDefined();
    expect(tool.part.toolName).toBe('read');
    expect(tool.part.state.input.filePath).toBe('hello.ts');

    // ── REPLAY ──
    const collector = new CollectorStream();
    const bridge = backend.createBridge(sid);
    bridge.setStream(collector as any);
    for (const event of events) bridge.processEvent(event);

    expect(collector.buildTurn()).toBeDefined();
    expect(collector.parts.length).toBeGreaterThanOrEqual(1);
    console.log(`[E2E] Replay: ${collector.parts.length} parts`);
    console.log(`[E2E] ✅ Full roundtrip complete`);
  }, 30000);
});
