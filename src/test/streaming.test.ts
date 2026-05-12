import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { StreamBridge } from '../participant/streaming';
import type { MessagePartDeltaEvent, OpenCodeEvent, SessionIdleEvent } from '../types/events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockStream = vscode.ChatResponseStream & {
  thinkingProgress: ReturnType<typeof vi.fn>;
  beginToolInvocation: ReturnType<typeof vi.fn>;
  updateToolInvocation: ReturnType<typeof vi.fn>;
};

function mockStream(opts?: { withProposed?: boolean }): MockStream {
  const stream: Partial<MockStream> = {
    markdown: vi.fn(),
    progress: vi.fn(),
    push: vi.fn(),
  };
  if (opts?.withProposed !== false) {
    stream.thinkingProgress = vi.fn();
    stream.beginToolInvocation = vi.fn();
    stream.updateToolInvocation = vi.fn();
  }
  return stream as MockStream;
}

function mockToken(isCancelled = false): vscode.CancellationToken {
  return {
    isCancellationRequested: isCancelled,
    onCancellationRequested: vi.fn(),
  };
}

function eventStream(events: OpenCodeEvent[]): { stream: AsyncIterable<OpenCodeEvent> } {
  async function* gen(): AsyncIterable<OpenCodeEvent> {
    for (const e of events) yield e;
  }
  return { stream: gen() };
}

function deltaEvent(delta: string, partID = 'prt_ai1'): MessagePartDeltaEvent {
  return {
    type: 'message.part.delta',
    properties: { partID, delta, field: 'text' },
  };
}

function idleEvent(): SessionIdleEvent {
  return {
    type: 'session.idle',
    properties: {},
  };
}

function idleEventFor(sessionID: string): SessionIdleEvent {
  return {
    type: 'session.idle',
    properties: { sessionID },
  };
}

function toolEvents(opts: {
  toolName: string;
  callID: string;
  input?: Record<string, unknown>;
  output?: string;
  title?: string;
  timeStart?: number;
  timeEnd?: number;
}): OpenCodeEvent[] {
  const partId = 'prt_tool001';
  return [
    {
      type: 'message.part.updated',
      properties: { part: { type: 'tool', tool: opts.toolName, id: partId, callID: opts.callID, state: { status: 'pending', input: {} } } },
    },
    {
      type: 'message.part.updated',
      properties: { part: { type: 'tool', tool: opts.toolName, id: partId, callID: opts.callID, state: { status: 'running', input: opts.input ?? {}, title: opts.title, time: opts.timeStart != null ? { start: opts.timeStart } : undefined } } },
    },
    {
      type: 'message.part.updated',
      properties: { part: { type: 'tool', tool: opts.toolName, id: partId, callID: opts.callID, state: { status: 'completed', input: opts.input ?? {}, output: opts.output ?? '', title: opts.title, time: { start: opts.timeStart ?? 0, end: opts.timeEnd ?? 100 } } } },
    },
  ] satisfies OpenCodeEvent[];
}

function fullTurnEvents(opts: { tools?: OpenCodeEvent[]; aiDeltas?: string[] }): OpenCodeEvent[] {
  const tools = opts.tools ?? toolEvents({ toolName: 'read', callID: 'call_001', input: { filePath: '/f.txt' }, output: 'hello' });
  const aiDeltas = opts.aiDeltas ?? ['OK'];

  return [
    { type: 'message.part.updated', properties: { part: { type: 'text', text: 'do it', messageID: 'msg_u1', id: 'prt_u1' } } },
    { type: 'message.part.updated', properties: { part: { type: 'step-start', messageID: 'msg_a1', id: 'prt_s1' } } },
    ...tools,
    { type: 'message.part.updated', properties: { part: { type: 'text', text: '', messageID: 'msg_a1', id: 'prt_ai1' } } },
    ...aiDeltas.map((d: string) => deltaEvent(d)),
    idleEvent(),
  ] satisfies OpenCodeEvent[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StreamBridge', () => {
  let bridge: StreamBridge;

  beforeEach(() => {
    bridge = new StreamBridge();
  });

  it('should complete a full turn with tool + AI text', async () => {
    const stream = mockStream();
    const events = eventStream(fullTurnEvents({}));
    const result = await bridge.bridgeEventsToStream(events, stream, mockToken());
    expect(result).toBe(true);
    expect(stream.markdown).toHaveBeenCalledWith('OK');
  });

  it('should stream AI text even when user echo is missing', async () => {
    const stream = mockStream();
    const events = eventStream([
      { type: 'message.part.updated', properties: { part: { type: 'step-start', messageID: 'msg_a1', id: 'prt_s1' } } },
      { type: 'message.part.updated', properties: { part: { type: 'text', text: 'Hello', messageID: 'msg_a1', id: 'prt_ai1' } } },
      deltaEvent(' world', 'prt_ai1'),
      idleEvent(),
    ]);

    const result = await bridge.bridgeEventsToStream(events, stream, mockToken());

    expect(result).toBe(true);
    expect(stream.markdown).toHaveBeenCalledWith(' world');
    expect(bridge.getUserMessageId()).toBeNull();
  });

  // --- Tool: read → SimpleToolResultData ---

  it('should push read tool as SimpleToolResultData', async () => {
    const stream = mockStream();
    const events = eventStream(fullTurnEvents({
      tools: toolEvents({ toolName: 'read', callID: 'call_rd', input: { filePath: '/src/main.ts' }, output: 'line1\nline2', title: 'main.ts', timeStart: 1000, timeEnd: 1500 }),
    }));
    await bridge.bridgeEventsToStream(events, stream, mockToken());
    expect(stream.beginToolInvocation).toHaveBeenCalledWith('call_rd', 'read');
    expect(stream.push).toHaveBeenCalled();
    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pushed.toolName).toBe('read');
    expect(pushed.isComplete).toBe(true);
    expect(pushed.pastTenseMessage).toMatch(/Read.*main\.ts/);
  });

  // --- Tool: bash → TerminalToolData ---

  it('should push bash tool as TerminalToolData', async () => {
    const stream = mockStream();
    const events = eventStream(fullTurnEvents({
      tools: toolEvents({ toolName: 'bash', callID: 'call_sh', input: { command: 'ls -la' }, output: 'total 42', title: 'bash', timeStart: 1000, timeEnd: 3200 }),
    }));
    await bridge.bridgeEventsToStream(events, stream, mockToken());
    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pushed.toolSpecificData.commandLine.original).toBe('ls -la');
    expect(pushed.toolSpecificData.output.text).toContain('total 42');
    expect(pushed.pastTenseMessage).toMatch(/Ran bash.*2\.2s/);
  });

  // --- Tool: write with filePath → ToolResourcesData ---

  it('should push write tool with filePath as ToolResourcesData', async () => {
    const stream = mockStream();
    const events = eventStream(fullTurnEvents({
      tools: toolEvents({ toolName: 'write', callID: 'call_wr', input: { filePath: '/src/new.ts', content: 'x' }, output: 'ok', title: 'new.ts' }),
    }));
    await bridge.bridgeEventsToStream(events, stream, mockToken());
    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pushed.toolSpecificData.values).toBeDefined();
  });

  // --- Tool: task/subagent → SubagentToolData ---

  it('should push subagent tool as SubagentToolData', async () => {
    const stream = mockStream();
    const events = eventStream(fullTurnEvents({
      tools: toolEvents({ toolName: 'task', callID: 'call_sub', input: { agentName: 'code-search', prompt: 'Find foo()' }, output: 'Found 5', title: 'search' }),
    }));
    await bridge.bridgeEventsToStream(events, stream, mockToken());
    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pushed.toolSpecificData.agentName).toBe('code-search');
    expect(pushed.toolSpecificData.result).toBe('Found 5');
  });

  // --- Streaming: pending → running → completed ---

  it('should call beginToolInvocation on pending, updateToolInvocation on running', async () => {
    const stream = mockStream();
    const events = eventStream(fullTurnEvents({
      tools: toolEvents({ toolName: 'read', callID: 'call_rd', input: { filePath: '/f.txt' }, output: 'content' }),
    }));
    await bridge.bridgeEventsToStream(events, stream, mockToken());
    expect(stream.beginToolInvocation).toHaveBeenCalledWith('call_rd', 'read');
    expect(stream.updateToolInvocation).toHaveBeenCalledWith('call_rd', { partialInput: { filePath: '/f.txt' } });
  });

  // --- Multiple tools ---

  it('should handle multiple tool calls', async () => {
    const stream = mockStream();
    const events = eventStream(fullTurnEvents({
      tools: [
        ...toolEvents({ toolName: 'read', callID: 'call_a', input: { filePath: '/a.txt' }, output: 'aaa', title: 'a.txt' }),
        ...toolEvents({ toolName: 'read', callID: 'call_b', input: { filePath: '/b.txt' }, output: 'bbb', title: 'b.txt' }),
      ],
      aiDeltas: ['Done'],
    }));
    await bridge.bridgeEventsToStream(events, stream, mockToken());
    expect(stream.beginToolInvocation).toHaveBeenCalledTimes(2);
    expect(stream.push).toHaveBeenCalledTimes(2);
  });

  // --- Fallback without proposed API ---

  it('should fallback to markdown when proposed API unavailable', async () => {
    const stream = mockStream({ withProposed: false });
    const events = eventStream(fullTurnEvents({
      tools: toolEvents({ toolName: 'read', callID: 'call_rd', input: { filePath: '/f.txt' }, output: 'content', title: 'f.txt' }),
    }));
    await bridge.bridgeEventsToStream(events, stream, mockToken());
    expect(stream.progress).toHaveBeenCalledWith('🔧 read...');
    const m = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string)
      .join('');
    expect(m).toContain('f.txt');
  });

  // --- Reasoning ---

  it('should stream reasoning via thinkingProgress', async () => {
    const stream = mockStream();
    const pid = 'prt_r1';
    const events = eventStream([
      { type: 'message.part.updated', properties: { part: { type: 'text', text: 'hi', messageID: 'msg_u1', id: 'prt_u1' } } },
      { type: 'message.part.updated', properties: { part: { type: 'reasoning', text: '', messageID: 'msg_a1', id: pid } } },
      deltaEvent('think', pid),
      idleEvent(),
    ]);
    await bridge.bridgeEventsToStream(events, stream, mockToken());
    expect(stream.thinkingProgress).toHaveBeenCalledWith(expect.objectContaining({ text: 'think' }));
  });

  // --- session.idle ---

  it('should stop on session.idle', async () => {
    const stream = mockStream();
    const events = eventStream([
      { type: 'message.part.updated', properties: { part: { type: 'text', text: 'hi', messageID: 'msg_u1', id: 'prt_u1' } } },
      { type: 'message.part.updated', properties: { part: { type: 'text', text: '', messageID: 'msg_a1', id: 'prt_ai1' } } },
      deltaEvent('Yes'),
      idleEvent(),
      deltaEvent('IGNORED'),
    ]);
    await bridge.bridgeEventsToStream(events, stream, mockToken());
    expect(stream.markdown).toHaveBeenCalledWith('Yes');
    expect(stream.markdown).not.toHaveBeenCalledWith('IGNORED');
  });

  it('should ignore session.idle from a different session when target session is set', async () => {
    const stream = mockStream();
    const scopedBridge = new StreamBridge({ sessionId: 'ses_target' });
    const events = eventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: { type: 'text', text: '', messageID: 'msg_a1', id: 'prt_ai1', sessionID: 'ses_target' },
        },
      },
      deltaEvent('Hello', 'prt_ai1'),
      idleEventFor('ses_other'),
      deltaEvent(' world', 'prt_ai1'),
      idleEventFor('ses_target'),
      deltaEvent('IGNORED', 'prt_ai1'),
    ]);

    await scopedBridge.bridgeEventsToStream(events, stream, mockToken());

    expect(stream.markdown).toHaveBeenCalledWith('Hello');
    expect(stream.markdown).toHaveBeenCalledWith(' world');
    expect(stream.markdown).not.toHaveBeenCalledWith('IGNORED');
  });

  // --- Cancellation ---

  it('should return false when cancelled', async () => {
    const stream = mockStream();
    const r = await bridge.bridgeEventsToStream(eventStream(fullTurnEvents({})), stream, mockToken(true));
    expect(r).toBe(false);
  });

  it('should return true when completed normally', async () => {
    const stream = mockStream();
    const r = await bridge.bridgeEventsToStream(eventStream(fullTurnEvents({})), stream, mockToken());
    expect(r).toBe(true);
  });

  // --- Reset ---

  it('should reset state between bridge calls', async () => {
    const s1 = mockStream();
    await bridge.bridgeEventsToStream(eventStream(fullTurnEvents({ tools: toolEvents({ toolName: 'read', callID: 'call_a', output: 'a' }) })), s1, mockToken());
    const s2 = mockStream();
    await bridge.bridgeEventsToStream(eventStream(fullTurnEvents({ tools: toolEvents({ toolName: 'read', callID: 'call_b', output: 'b' }) })), s2, mockToken());
    expect((s2.push as ReturnType<typeof vi.fn>).mock.calls[0][0].toolSpecificData.output).toBe('b');
  });

  // --- Edge cases ---

  it('should handle empty delta', async () => {
    const stream = mockStream();
    await bridge.bridgeEventsToStream(eventStream([deltaEvent('', 'x'), idleEvent()]), stream, mockToken());
    expect(stream.markdown).not.toHaveBeenCalled();
  });

  it('should handle unknown partID delta', async () => {
    const stream = mockStream();
    await bridge.bridgeEventsToStream(eventStream([deltaEvent('x', 'prt_unknown'), idleEvent()]), stream, mockToken());
    expect(stream.markdown).not.toHaveBeenCalledWith('x');
  });

  it('should handle tool without callID (uses part.id)', async () => {
    const stream = mockStream();
    const pid = 'prt_tool001';
    const events = eventStream([
      { type: 'message.part.updated', properties: { part: { type: 'text', text: 'hi', messageID: 'msg_u1', id: 'prt_u1' } } },
      { type: 'message.part.updated', properties: { part: { type: 'step-start', messageID: 'msg_a1', id: 'prt_s1' } } },
      { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'read', id: pid, state: { status: 'pending', input: {} } } } },
      { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'read', id: pid, state: { status: 'completed', input: { filePath: '/x.txt' }, output: 'ok' } } } },
      idleEvent(),
    ]);
    await bridge.bridgeEventsToStream(events, stream, mockToken());
    expect(stream.beginToolInvocation).toHaveBeenCalledWith(pid, 'read');
  });
});
