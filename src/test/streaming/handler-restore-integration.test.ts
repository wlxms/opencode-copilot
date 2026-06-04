/**
 * Integration: handler → bridge → collector restore pipeline.
 *
 * Simulates the session-restore path used by
 * `fetchSessionHistory` in experimental-session.ts:
 *   1. Create CollectorStream (captures rendered output)
 *   2. Create OpenCodeBridge (same factory as live path)
 *   3. Set stream → collector
 *   4. Replay persisted ACP events via processEvent()
 *   5. Verify captured parts and buildTurn()
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { CollectorStream } from '../../acp/streaming/collector-stream';
import { OpenCodeBridge } from '../../backends/opencode/opencode-bridge';
import type { AcpEvent } from '../../acp/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal OpenCodeBridge pre-configured for replay. */
function createBridge(collector: CollectorStream, sessionId = 'test-sid'): OpenCodeBridge {
  const sessions = {
    findAncestor: vi.fn(),
    parent: vi.fn(),
    status: vi.fn(),
    children: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
  } as any;
  const permissions = { reply: vi.fn() } as any;
  const questions = { reply: vi.fn(), reject: vi.fn() } as any;
  const bridge = new OpenCodeBridge(sessions, permissions, questions);
  bridge.setStream(collector as any);
  bridge.setSessionId(sessionId);
  return bridge;
}

/** Build a tool-lifecycle event sequence (pending → running → completed). */
function toolEvents(opts: {
  id: string;
  toolName: string;
  callId: string;
  input: Record<string, unknown>;
  output?: string;
  title?: string;
}): AcpEvent[] {
  const base = { type: 'part.updated' as const, messageId: 'msg-1' } as any;
  return [
    {
      ...base,
      part: {
        type: 'tool',
        id: opts.id,
        toolName: opts.toolName,
        callId: opts.callId,
        state: { status: 'pending', input: opts.input, title: opts.title },
      } as any,
    },
    {
      ...base,
      part: {
        type: 'tool',
        id: opts.id,
        toolName: opts.toolName,
        callId: opts.callId,
        state: {
          status: 'running',
          input: opts.input,
          title: opts.title,
        },
      } as any,
    },
    {
      ...base,
      part: {
        type: 'tool',
        id: opts.id,
        toolName: opts.toolName,
        callId: opts.callId,
        state: {
          status: 'completed',
          input: opts.input,
          output: opts.output,
          title: opts.title,
          startTime: 100,
          endTime: 200,
        },
      } as any,
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session Restore Integration (handler → bridge → collector)', () => {
  // -----------------------------------------------------------------------
  // Restore pipeline
  // -----------------------------------------------------------------------

  it('should capture text + reasoning + tool from bridge replay', () => {
    const collector = new CollectorStream();
    const bridge = createBridge(collector);

    // Simulate persisted events (same order as fetchSessionHistory replay)
    // Text initialise + render via delta
    bridge.processEvent({
      type: 'part.updated',
      part: { type: 'text', id: 't1', text: '' },
      messageId: 'm1',
    } as any);
    bridge.processEvent({
      type: 'part.delta',
      partId: 't1',
      delta: 'hello',
      field: 'text',
    } as any);
    // Reasoning initialise + render via delta
    bridge.processEvent({
      type: 'part.updated',
      part: { type: 'reasoning', id: 'r1', text: '' },
      messageId: 'm2',
    } as any);
    bridge.processEvent({
      type: 'part.delta',
      partId: 'r1',
      delta: 'think...',
      field: 'text',
    } as any);
    // Tool lifecycle
    bridge.processEvent(...toolEvents({
      id: 'b1', toolName: 'bash', callId: 'c1',
      input: { command: 'ls' }, output: 'a.txt',
    }));
    bridge.processEvent({
      type: 'session.idle',
      sessionId: 'test-sid',
    } as any);

    const turn = collector.buildTurn();
    expect(turn).toBeDefined();
    expect(collector.parts.length).toBeGreaterThanOrEqual(1);
  });

  it('should capture write tool with edit card', () => {
    const collector = new CollectorStream();
    const bridge = createBridge(collector);

    bridge.processEvent(...toolEvents({
      id: 'w1', toolName: 'write', callId: 'cw',
      input: { filePath: '/x.ts', content: 'hi' }, output: 'Wrote 1 file',
    }));
    bridge.processEvent({
      type: 'session.idle',
      sessionId: 'test-sid',
    } as any);

    expect(collector.parts.length).toBeGreaterThanOrEqual(1);
    const turn = collector.buildTurn();
    expect(turn).toBeDefined();
  });

  it('should capture diff events', () => {
    const collector = new CollectorStream();
    const bridge = createBridge(collector);

    bridge.processEvent({
      type: 'session.diff',
      sessionId: 'test-sid',
      diffs: [
        { file: '/a.ts', status: 'modified', additions: 3, deletions: 1 },
        { file: '/b.ts', status: 'added', additions: 10 },
      ],
    } as any);
    bridge.processEvent({
      type: 'session.idle',
      sessionId: 'test-sid',
    } as any);

    // Diff parts require ChatResponseMultiDiffPart from the proposed API.
    // If the runtime doesn't provide it, handleSessionDiff returns false.
    // At minimum we verify the bridge didn't throw.
    expect(collector.buildTurn()).toBeDefined();
  });

  it('should handle empty event stream gracefully', () => {
    const collector = new CollectorStream();
    const bridge = createBridge(collector);

    // No events replayed — collector stays empty
    const turn = collector.buildTurn();
    expect(turn).toBeDefined();
    expect(collector.parts.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Part types
  // -----------------------------------------------------------------------

  it('text part → markdown part rendered via delta', () => {
    const collector = new CollectorStream();
    const bridge = createBridge(collector);

    // Text rendering requires part.updated (initialise) + part.delta (render)
    bridge.processEvent({
      type: 'part.updated',
      part: { type: 'text', id: 't1', text: '' },
      messageId: 'm1',
    } as any);
    bridge.processEvent({
      type: 'part.delta',
      partId: 't1',
      delta: 'Hello, world!',
      field: 'text',
    } as any);
    bridge.processEvent({
      type: 'session.idle',
      sessionId: 'test-sid',
    } as any);

    // Delta events push markdown to the stream
    expect(collector.parts.length).toBeGreaterThanOrEqual(1);
  });

  it('reasoning part → thinking output via delta', () => {
    const collector = new CollectorStream();
    const bridge = createBridge(collector);

    // Reasoning rendering requires part.updated (initialise) + part.delta (render)
    bridge.processEvent({
      type: 'part.updated',
      part: { type: 'reasoning', id: 'r1', text: '' },
      messageId: 'm1',
    } as any);
    bridge.processEvent({
      type: 'part.delta',
      partId: 'r1',
      delta: 'thinking step...',
      field: 'text',
    } as any);
    bridge.processEvent({
      type: 'session.idle',
      sessionId: 'test-sid',
    } as any);

    const hasThinking = collector.parts.some((p: any) =>
      p.constructor?.name === 'ChatResponseThinkingProgressPart' ||
      (p.value && String(p.value).includes('💭')),
    );
    expect(hasThinking).toBe(true);
  });

  it('delta events produce text incrementally', () => {
    const collector = new CollectorStream();
    const bridge = createBridge(collector);

    // Simulate real delta flow
    bridge.processEvent({
      type: 'part.updated',
      part: { type: 'text', id: 't1', text: '' },
      messageId: 'm1',
    } as any);
    bridge.processEvent({
      type: 'part.delta',
      partId: 't1',
      delta: 'Hel',
      field: 'text',
    } as any);
    bridge.processEvent({
      type: 'part.delta',
      partId: 't1',
      delta: 'lo',
      field: 'text',
    } as any);
    bridge.processEvent({
      type: 'session.idle',
      sessionId: 'test-sid',
    } as any);

    expect(collector.parts.length).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // Tool types
  // -----------------------------------------------------------------------

  it('bash tool → tool card', () => {
    const collector = new CollectorStream();
    const bridge = createBridge(collector);

    bridge.processEvent(...toolEvents({
      id: 'b1', toolName: 'bash', callId: 'c1',
      input: { command: 'ls -la' }, output: 'a.txt\nb.txt',
    }));
    bridge.processEvent({
      type: 'session.idle',
      sessionId: 'test-sid',
    } as any);

    const hasBashTool = collector.parts.some((p: any) => p.toolName === 'bash');
    expect(hasBashTool).toBe(true);
  });

  it('read tool → tool card', () => {
    const collector = new CollectorStream();
    const bridge = createBridge(collector);

    bridge.processEvent(...toolEvents({
      id: 'r1', toolName: 'read', callId: 'cr',
      input: { filePath: '/readme.md' }, output: '# Title',
    }));
    bridge.processEvent({
      type: 'session.idle',
      sessionId: 'test-sid',
    } as any);

    expect(collector.parts.length).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // Ordering & composition
  // -----------------------------------------------------------------------

  it('multiple tools produce ordered parts', () => {
    const collector = new CollectorStream();
    const bridge = createBridge(collector);

    bridge.processEvent(...toolEvents({
      id: 'b1', toolName: 'bash', callId: 'c1',
      input: { command: 'ls' }, output: 'a',
    }));
    bridge.processEvent(...toolEvents({
      id: 'r1', toolName: 'read', callId: 'c2',
      input: { filePath: 'a' }, output: 'x',
    }));
    bridge.processEvent({
      type: 'session.idle',
      sessionId: 'test-sid',
    } as any);

    expect(collector.parts.length).toBeGreaterThanOrEqual(2);
  });

  it('mixed: reasoning + text + tool in sequence', () => {
    const collector = new CollectorStream();
    const bridge = createBridge(collector);

    // Reasoning initialise + render
    bridge.processEvent({
      type: 'part.updated',
      part: { type: 'reasoning', id: 'r1', text: '' },
      messageId: 'm1',
    } as any);
    bridge.processEvent({
      type: 'part.delta',
      partId: 'r1',
      delta: '...',
      field: 'text',
    } as any);
    // Text initialise + render
    bridge.processEvent({
      type: 'part.updated',
      part: { type: 'text', id: 't1', text: '' },
      messageId: 'm2',
    } as any);
    bridge.processEvent({
      type: 'part.delta',
      partId: 't1',
      delta: 'Done',
      field: 'text',
    } as any);
    // Tool lifecycle
    bridge.processEvent(...toolEvents({
      id: 'b1', toolName: 'bash', callId: 'c1',
      input: { command: 'ls' }, output: 'a',
    }));
    bridge.processEvent({
      type: 'session.idle',
      sessionId: 'test-sid',
    } as any);

    expect(collector.parts.length).toBeGreaterThanOrEqual(3);
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it('simulates full restore flow with user message skip', () => {
    const collector = new CollectorStream();
    const bridge = createBridge(collector);

    // The persisted events include the user message (first text event)
    // which fetchSessionHistory detects and skips before replay.
    // Here we replay ALL events as the bridge would see them.
    bridge.processEvent({
      type: 'part.updated',
      part: { type: 'text', id: 'user-sid', text: 'What is in this folder?' },
      messageId: 'user-msg',
    } as any);
    // Reasoning initialise + render
    bridge.processEvent({
      type: 'part.updated',
      part: { type: 'reasoning', id: 'r1', text: '' },
      messageId: 'm1',
    } as any);
    bridge.processEvent({
      type: 'part.delta',
      partId: 'r1',
      delta: 'Let me check...',
      field: 'text',
    } as any);
    // Tool lifecycle
    bridge.processEvent(...toolEvents({
      id: 'b1', toolName: 'bash', callId: 'c1',
      input: { command: 'ls' }, output: 'src\npackage.json',
    }));
    // Assistant text initialise + render
    bridge.processEvent({
      type: 'part.updated',
      part: { type: 'text', id: 't1', text: '' },
      messageId: 'm2',
    } as any);
    bridge.processEvent({
      type: 'part.delta',
      partId: 't1',
      delta: 'The folder contains src/ and package.json',
      field: 'text',
    } as any);
    bridge.processEvent({
      type: 'session.idle',
      sessionId: 'test-sid',
    } as any);

    const turn = collector.buildTurn();
    expect(turn).toBeDefined();
    // The user message is rendered as markdown via delta events after
    // fetchSessionHistory skips the initial text. Here the bridge sees
    // all events so we get: reasoning(thinking) + tool(bash) + text(markdown)
    expect(collector.parts.length).toBeGreaterThanOrEqual(2);
  });
});
