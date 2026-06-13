/**
 * Integration: Event replay via Bridge → CollectorStream.
 * Verifies runtime checklist using mock AcpEvents.
 */
import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { CollectorStream } from '../../acp/streaming/collector-stream';
import { OpenCodeBridge } from '../../backends/opencode/opencode-bridge';
import type { AcpEvent } from '../../acp/types';

function replay(events: AcpEvent[]): CollectorStream {
  const c = new CollectorStream();
  const sessionsMock = { create: vi.fn(), get: vi.fn() } as any;
  const permissionsMock = { reply: vi.fn() } as any;
  const questionsMock = { reply: vi.fn(), reject: vi.fn() } as any;
  const b = new OpenCodeBridge(sessionsMock, permissionsMock, questionsMock);
  b.setStream(c as any);
  for (const e of events) b.processEvent(e);
  return c;
}

function toolEvents(opts: { id: string; toolName: string; callId: string; input: Record<string, unknown>; output?: string; title?: string }): AcpEvent[] {
  const base = { type: 'part.updated' as const, messageId: 'msg-1' } as any;
  return [
    { ...base, part: { type: 'tool', id: opts.id, toolName: opts.toolName, callId: opts.callId, state: { status: 'pending', input: opts.input, title: opts.title } } as any },
    { ...base, part: { type: 'tool', id: opts.id, toolName: opts.toolName, callId: opts.callId, state: { status: 'running', input: opts.input, title: opts.title } } as any },
    { ...base, part: { type: 'tool', id: opts.id, toolName: opts.toolName, callId: opts.callId, state: { status: 'completed', input: opts.input, output: opts.output, title: opts.title, startTime: 100, endTime: 200 } } as any },
  ];
}

describe('Event Replay via Bridge+CollectorStream', () => {

  it('text → markdown part', () => {
    const c = replay([
      { type: 'part.updated', part: { type: 'text', id: 't1', text: '' } as any, messageId: 'm1' } as AcpEvent,
      { type: 'part.delta', partId: 't1', delta: 'Hello', field: 'text' } as AcpEvent,
      { type: 'session.idle', sessionId: 's' } as AcpEvent,
    ]);
    expect(c.parts.length).toBeGreaterThanOrEqual(1);
    expect(c.buildTurn()).toBeDefined();
  });

  it('reasoning → thinking output', () => {
    const c = replay([
      { type: 'part.updated', part: { type: 'reasoning', id: 'r1', text: 'think...' } as any, messageId: 'm1' } as AcpEvent,
      { type: 'part.delta', partId: 'r1', delta: 'think...', field: 'text' } as AcpEvent,
      { type: 'session.idle', sessionId: 's' } as AcpEvent,
    ]);
    const hasThinking = c.parts.some((p: any) =>
      p.constructor?.name === 'ChatResponseThinkingProgressPart' ||
      (p.value && String(p.value).includes('💭'))
    );
    expect(hasThinking).toBe(true);
  });

  it('bash tool → tool card', () => {
    const c = replay([
      ...toolEvents({ id: 'b1', toolName: 'bash', callId: 'c1', input: { command: 'ls' }, output: 'a.txt', title: 'ls' }),
      { type: 'session.idle', sessionId: 's' } as AcpEvent,
    ]);
    expect(c.parts.some((p: any) => p.toolName === 'bash')).toBe(true);
  });

  it('write tool → tool card', () => {
    const c = replay([
      ...toolEvents({ id: 'w1', toolName: 'write', callId: 'cw', input: { filePath: '/x.ts', content: 'hi' }, output: 'Wrote', title: 'write' }),
      { type: 'session.idle', sessionId: 's' } as AcpEvent,
    ]);
    expect(c.parts.length).toBeGreaterThanOrEqual(1);
  });

  it('read tool → tool card', () => {
    const c = replay([
      ...toolEvents({ id: 'r1', toolName: 'read', callId: 'cr', input: { filePath: '/r.md' }, output: '# H' }),
      { type: 'session.idle', sessionId: 's' } as AcpEvent,
    ]);
    expect(c.parts.length).toBeGreaterThanOrEqual(1);
  });

  it('multiple tools → ordered parts', () => {
    const c = replay([
      ...toolEvents({ id: 'b1', toolName: 'bash', callId: 'c1', input: { command: 'ls' }, output: 'a' }),
      ...toolEvents({ id: 'r1', toolName: 'read', callId: 'c2', input: { filePath: 'a' }, output: 'x' }),
      { type: 'session.idle', sessionId: 's' } as AcpEvent,
    ]);
    expect(c.parts.length).toBeGreaterThanOrEqual(2);
  });

  it('empty turn is valid', () => {
    expect(new CollectorStream().buildTurn()).toBeDefined();
  });

  it('mixed: reasoning + text + tool', () => {
    const c = replay([
      { type: 'part.updated', part: { type: 'reasoning', id: 'r1', text: '...' } as any, messageId: 'm1' } as AcpEvent,
      { type: 'part.updated', part: { type: 'text', id: 't1', text: 'Done' } as any, messageId: 'm2' } as AcpEvent,
      ...toolEvents({ id: 'b1', toolName: 'bash', callId: 'c1', input: { command: 'ls' }, output: 'a' }),
      { type: 'session.idle', sessionId: 's' } as AcpEvent,
    ]);
    expect(c.parts.length).toBeGreaterThanOrEqual(3);
  });
});
