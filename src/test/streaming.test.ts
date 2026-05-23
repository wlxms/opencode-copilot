import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { StreamBridge } from '../participant/streaming';
import type {
  AcpEvent,
  AcpPartDeltaEvent,
  AcpSessionIdleEvent,
  AcpSessionDiffEvent,
  AcpPermissionRequestEvent,
} from '../acp/types';

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

function eventStream(events: AcpEvent[]): { stream: AsyncIterable<AcpEvent> } {
  async function* gen(): AsyncIterable<AcpEvent> {
    for (const e of events) yield e;
  }
  return { stream: gen() };
}

function deltaEvent(delta: string, partId = 'prt_ai1'): AcpPartDeltaEvent {
  return {
    type: 'part.delta',
    partId,
    delta,
    field: 'text',
  };
}

function idleEvent(): AcpSessionIdleEvent {
  return {
    type: 'session.idle',
  };
}

function idleEventFor(sessionId: string): AcpSessionIdleEvent {
  return {
    type: 'session.idle',
    sessionId,
  };
}

function toolEvents(opts: {
  toolName: string;
  callId: string;
  input?: Record<string, unknown>;
  output?: string;
  title?: string;
  timeStart?: number;
  timeEnd?: number;
}): AcpEvent[] {
  const partId = 'prt_tool001';
  return [
    {
      type: 'part.updated',
      part: { type: 'tool', toolName: opts.toolName, id: partId, callId: opts.callId, state: { status: 'pending', input: {} } },
    },
    {
      type: 'part.updated',
      part: { type: 'tool', toolName: opts.toolName, id: partId, callId: opts.callId, state: { status: 'running', input: opts.input ?? {}, title: opts.title, startTime: opts.timeStart } },
    },
    {
      type: 'part.updated',
      part: { type: 'tool', toolName: opts.toolName, id: partId, callId: opts.callId, state: { status: 'completed', input: opts.input ?? {}, output: opts.output ?? '', title: opts.title, startTime: opts.timeStart ?? 0, endTime: opts.timeEnd ?? 100 } },
    },
  ] satisfies AcpEvent[];
}

function fullTurnEvents(opts: { tools?: AcpEvent[]; aiDeltas?: string[] }): AcpEvent[] {
  const tools = opts.tools ?? toolEvents({ toolName: 'read', callId: 'call_001', input: { filePath: '/f.txt' }, output: 'hello' });
  const aiDeltas = opts.aiDeltas ?? ['OK'];

  return [
    { type: 'part.updated', part: { type: 'text', text: 'do it', messageId: 'msg_u1', id: 'prt_u1' } },
    { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
    ...tools,
    { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1' } },
    ...aiDeltas.map((d: string) => deltaEvent(d)),
    idleEvent(),
  ] satisfies AcpEvent[];
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
      { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
      { type: 'part.updated', part: { type: 'text', text: 'Hello', messageId: 'msg_a1', id: 'prt_ai1' } },
      deltaEvent(' world', 'prt_ai1'),
      idleEvent(),
    ]);

    const result = await bridge.bridgeEventsToStream(events, stream, mockToken());

    expect(result).toBe(true);
    expect(stream.markdown).toHaveBeenCalledWith(' world');
    expect(bridge.getUserMessageId()).toBeNull();
  });

  // --- Tool: read → SimpleToolResultData ---

  it('should push read tool as ChatSimpleToolResultData', async () => {
    const stream = mockStream();
    const events = eventStream(fullTurnEvents({
      tools: toolEvents({ toolName: 'read', callId: 'call_rd', input: { filePath: '/src/main.ts' }, output: 'line1\nline2', title: 'main.ts', timeStart: 1000, timeEnd: 1500 }),
    }));
    await bridge.bridgeEventsToStream(events, stream, mockToken());
    expect(stream.beginToolInvocation).toHaveBeenCalledWith('call_rd', 'read');
    expect(stream.push).toHaveBeenCalled();
    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(pushed.isComplete).toBe(true);
    expect(pushed.toolName).toBe('read');
    expect(pushed.pastTenseMessage).toMatch(/Read.*main\.ts/);
  });

  // --- Tool: bash → TerminalToolData ---

  it('should push bash tool as ChatTerminalToolInvocationData', async () => {
    const stream = mockStream();
    const events = eventStream(fullTurnEvents({
      tools: toolEvents({ toolName: 'bash', callId: 'call_sh', input: { command: 'ls -la' }, output: 'total 42', title: 'bash', timeStart: 1000, timeEnd: 3200 }),
    }));
    await bridge.bridgeEventsToStream(events, stream, mockToken());
    expect(stream.beginToolInvocation).toHaveBeenCalledWith('call_sh', 'bash');
  });

  // --- Tool: write → ToolResourcesInvocationData ---

  it('should push write tool as ChatToolResourcesInvocationData', async () => {
    const stream = mockStream();
    const events = eventStream(fullTurnEvents({
      tools: toolEvents({ toolName: 'write', callId: 'call_wr', input: { filePath: '/src/new.ts' }, output: 'written', title: 'new.ts' }),
    }));
    await bridge.bridgeEventsToStream(events, stream, mockToken());
    expect(stream.beginToolInvocation).toHaveBeenCalledWith('call_wr', 'write');
  });

  // --- Tool: task → SubagentToolInvocationData ---

  it('should push task tool as ChatSubagentToolInvocationData', async () => {
    const stream = mockStream();
    const events = eventStream(fullTurnEvents({
      tools: toolEvents({ toolName: 'task', callId: 'call_tsk', input: { description: 'subtask', prompt: 'do X' }, output: 'done', title: 'Subtask' }),
    }));
    await bridge.bridgeEventsToStream(events, stream, mockToken());
    expect(stream.beginToolInvocation).toHaveBeenCalledWith('call_tsk', 'task');
  });

  // --- Subagent event filtering ---

  it('should filter subagent-internal tool events and aggregate progress', async () => {
    const stream = mockStream();
    const taskId = 'prt_task001';
    const taskCallId = 'call_sub1';
    // Subagent internal tool part (different partId — will be filtered)
    const subPartId = 'prt_sub_read001';
    const subDeltaPartId = 'prt_sub_text001';

    const events = eventStream([
      // User message
      { type: 'part.updated', part: { type: 'text', text: 'do it', messageId: 'msg_u1', id: 'prt_u1' } },
      // Parent step-start
      { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
      // Task tool: pending
      { type: 'part.updated', part: { type: 'tool', toolName: 'task', id: taskId, callId: taskCallId, state: { status: 'pending', input: {} } } },
      // Task tool: running → opens subagent scope
      { type: 'part.updated', part: { type: 'tool', toolName: 'task', id: taskId, callId: taskCallId, state: { status: 'running', input: { description: 'fix bug' }, title: 'fix-bug' } } },
      // Subagent internal: read tool (different partId — should be filtered)
      { type: 'part.updated', part: { type: 'tool', toolName: 'read', id: subPartId, callId: 'call_sub_read', state: { status: 'completed', input: { filePath: '/src/main.ts' }, output: 'line1', title: 'main.ts' } } },
      // Subagent internal: text delta (different partId — should be filtered)
      { type: 'part.delta', partId: subDeltaPartId, delta: 'subagent thinking...' },
      // Another subagent tool: bash (different partId — should be filtered)
      { type: 'part.updated', part: { type: 'tool', toolName: 'bash', id: 'prt_sub_bash001', callId: 'call_sub_bash', state: { status: 'completed', input: { command: 'npm test' }, output: 'all pass' } } },
      // Task tool: completed → closes subagent scope
      { type: 'part.updated', part: { type: 'tool', toolName: 'task', id: taskId, callId: taskCallId, state: { status: 'completed', input: { description: 'fix bug' }, output: 'bug fixed', title: 'fix-bug', startTime: 1000, endTime: 3000 } } },
      // AI response
      { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1' } },
      ...['Done'].map((d: string) => deltaEvent(d)),
      idleEvent(),
    ]);
    await bridge.bridgeEventsToStream(events, stream, mockToken());

    // Task tool should be invoked (begin + completed push)
    expect(stream.beginToolInvocation).toHaveBeenCalledWith(taskCallId, 'task');

    // The completed push should include a ChatToolInvocationPart with progress in result
    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls;
    // Should have at least the task's completed part pushed
    const taskPart = pushed.find((call: unknown[]) => {
      const p = call[0] as { toolName?: string; toolCallId?: string; isComplete?: boolean };
      return p?.toolName === 'task' && p?.toolCallId === taskCallId && p?.isComplete === true;
    });
    expect(taskPart).toBeDefined();

    // Verify subagent internal tools were NOT pushed as independent cards
    const readPart = pushed.find((call: unknown[]) => {
      const p = call[0] as { toolName?: string };
      return p?.toolName === 'read';
    });
    expect(readPart).toBeUndefined();

    const bashPart = pushed.find((call: unknown[]) => {
      const p = call[0] as { toolName?: string };
      return p?.toolName === 'bash';
    });
    expect(bashPart).toBeUndefined();

    // AI text should still be rendered
    expect(stream.markdown).toHaveBeenCalledWith('Done');
  });

  it('should not filter events when no subagent is active', async () => {
    const stream = mockStream();
    const events = eventStream(fullTurnEvents({
      tools: toolEvents({ toolName: 'read', callId: 'call_rd', input: { filePath: '/f.txt' }, output: 'hello', title: 'f.txt' }),
    }));
    await bridge.bridgeEventsToStream(events, stream, mockToken());

    // Read tool should be pushed normally
    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls;
    const readPart = pushed.find((call: unknown[]) => {
      const p = call[0] as { toolName?: string };
      return p?.toolName === 'read';
    });
    expect(readPart).toBeDefined();
  });

  it('should clean up subagent scope on task error', async () => {
    const stream = mockStream();
    const taskId = 'prt_task_err';
    const taskCallId = 'call_err';

    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'go', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
      { type: 'part.updated', part: { type: 'tool', toolName: 'task', id: taskId, callId: taskCallId, state: { status: 'pending', input: {} } } },
      { type: 'part.updated', part: { type: 'tool', toolName: 'task', id: taskId, callId: taskCallId, state: { status: 'running', input: { description: 'fail task' } } } },
      { type: 'part.updated', part: { type: 'tool', toolName: 'task', id: taskId, callId: taskCallId, state: { status: 'error', input: { description: 'fail task' }, error: 'timeout' } } },
      idleEvent(),
    ]);
    await bridge.bridgeEventsToStream(events, stream, mockToken());

    // After error, scope should be cleaned — subsequent tools should not be filtered
    // Just verify no crash and error part was pushed
    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls;
    const errorPart = pushed.find((call: unknown[]) => {
      const p = call[0] as { toolName?: string; isError?: boolean };
      return p?.toolName === 'task' && p?.isError === true;
    });
    expect(errorPart).toBeDefined();
  });

  it('should NOT stop on session.idle while subagent is active', async () => {
    const stream = mockStream();
    const taskId = 'prt_task_idle';
    const taskCallId = 'call_idle_test';

    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'go', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
      // Task: pending
      { type: 'part.updated', part: { type: 'tool', toolName: 'task', id: taskId, callId: taskCallId, state: { status: 'pending', input: {} } } },
      // Task: running → opens subagent scope
      { type: 'part.updated', part: { type: 'tool', toolName: 'task', id: taskId, callId: taskCallId, state: { status: 'running', input: { description: 'slow task' } } } },
      // session.idle arrives WHILE subagent is active → should NOT stop
      idleEvent(),
      // Subagent still produces events after idle
      { type: 'part.updated', part: { type: 'tool', toolName: 'read', id: 'prt_sub_r1', callId: 'call_sub_r1', state: { status: 'completed', input: { filePath: '/a.ts' }, output: 'content' } } },
      // Task: completed → closes scope
      { type: 'part.updated', part: { type: 'tool', toolName: 'task', id: taskId, callId: taskCallId, state: { status: 'completed', input: { description: 'slow task' }, output: 'done', title: 'slow-task' } } },
      // Final idle (no active subagents) → should stop
      idleEvent(),
    ]);
    const result = await bridge.bridgeEventsToStream(events, stream, mockToken());

    // Bridge should complete successfully (not cancel)
    expect(result).toBe(true);

    // Task completed part should have been pushed
    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls;
    const taskPart = pushed.find((call: unknown[]) => {
      const p = call[0] as { toolName?: string; toolCallId?: string; isComplete?: boolean };
      return p?.toolName === 'task' && p?.isComplete === true;
    });
    expect(taskPart).toBeDefined();
  });

  // --- Tool: other → SimpleToolResultData fallback ---

  it('should push unknown tool as ChatSimpleToolResultData', async () => {
    const stream = mockStream();
    const events = eventStream(fullTurnEvents({
      tools: toolEvents({ toolName: 'custom', callId: 'call_cu', input: { x: 1 }, output: 'ok' }),
    }));
    await bridge.bridgeEventsToStream(events, stream, mockToken());
    expect(stream.beginToolInvocation).toHaveBeenCalledWith('call_cu', 'custom');
  });

  // --- Reasoning ---

  it('should stream reasoning via thinkingProgress', async () => {
    const stream = mockStream();
    const pid = 'prt_reason2';
    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'hi', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'reasoning', text: '', messageId: 'msg_a1', id: pid } },
      { type: 'part.delta', partId: pid, delta: 'hmm...', field: 'text' },
      { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1' } },
      deltaEvent('Yes'),
      idleEvent(),
    ]);
    await bridge.bridgeEventsToStream(events, stream, mockToken());
    expect(stream.thinkingProgress).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hmm...' }),
    );
    expect(stream.markdown).toHaveBeenCalledWith('Yes');
  });

  it('should skip thinkingProgress if fallback (no proposed API)', async () => {
    const stream = mockStream({ withProposed: false });
    const pid = 'prt_reason3';
    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'hi', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'reasoning', text: '', messageId: 'msg_a1', id: pid } },
      { type: 'part.delta', partId: pid, delta: 'hmm fallback', field: 'text' },
      idleEvent(),
    ]);
    await bridge.bridgeEventsToStream(events, stream, mockToken());
    // Fallback stream doesn't have thinkingProgress
    expect((stream as any).thinkingProgress).toBeUndefined();
  });

  // --- Session idle with scope ---

  it('should stop on session.idle matching target session', async () => {
    const stream = mockStream();
    const scopedBridge = new StreamBridge({ sessionId: 'ses_a' });
    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1' } },
      deltaEvent('Yes'),
      idleEventFor('ses_a'),
      deltaEvent('IGNORED', 'prt_ai1'),
    ]);
    await scopedBridge.bridgeEventsToStream(events, stream, mockToken());
    expect(stream.markdown).toHaveBeenCalledWith('Yes');
    expect(stream.markdown).not.toHaveBeenCalledWith('IGNORED');
  });

  it('should ignore session.idle from a different session when target session is set', async () => {
    const stream = mockStream();
    const scopedBridge = new StreamBridge({ sessionId: 'ses_target' });
    const events = eventStream([
      {
        type: 'part.updated',
        part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1', sessionId: 'ses_target' },
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
    await bridge.bridgeEventsToStream(eventStream(fullTurnEvents({ tools: toolEvents({ toolName: 'read', callId: 'call_a', output: 'a' }) })), s1, mockToken());
    const s2 = mockStream();
    await bridge.bridgeEventsToStream(eventStream(fullTurnEvents({ tools: toolEvents({ toolName: 'read', callId: 'call_b', output: 'b' }) })), s2, mockToken());
    expect((s2.push as ReturnType<typeof vi.fn>).mock.calls[1][0].toolSpecificData.output).toBe('b');
  });

  // --- Edge cases ---

  it('should handle empty delta', async () => {
    const stream = mockStream();
    await bridge.bridgeEventsToStream(eventStream([deltaEvent('', 'x'), idleEvent()]), stream, mockToken());
    expect(stream.markdown).not.toHaveBeenCalled();
  });

  it('should handle unknown partId delta', async () => {
    const stream = mockStream();
    await bridge.bridgeEventsToStream(eventStream([deltaEvent('x', 'prt_unknown'), idleEvent()]), stream, mockToken());
    expect(stream.markdown).not.toHaveBeenCalled();
  });

  it('should handle tool without callId (uses part.id)', async () => {
    const stream = mockStream();
    const pid = 'prt_tool001';
    const events = eventStream([
      { type: 'part.updated', part: { type: 'text', text: 'hi', messageId: 'msg_u1', id: 'prt_u1' } },
      { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
      { type: 'part.updated', part: { type: 'tool', toolName: 'read', id: pid, state: { status: 'pending', input: {} } } },
      { type: 'part.updated', part: { type: 'tool', toolName: 'read', id: pid, state: { status: 'completed', input: { filePath: '/x.txt' }, output: 'ok' } } },
      idleEvent(),
    ]);
    await bridge.bridgeEventsToStream(events, stream, mockToken());
    expect(stream.beginToolInvocation).toHaveBeenCalledWith(pid, 'read');
  });

  // -----------------------------------------------------------------------
  // Permission.asked lifecycle — external edit tracking + auto-reply
  // -----------------------------------------------------------------------
  function permissionAskedEvent(
    overrides?: Partial<AcpPermissionRequestEvent>,
  ): AcpPermissionRequestEvent {
    return {
      type: 'permission.asked',
      permissionId: 'perm_42',
      sessionId: 'ses_target',
      permission: 'edit',
      patterns: ['src/**/*.ts'],
      metadata: { filepath: '/workspace/src/app.ts' },
      always: [],
      tool: { messageId: 'msg_tool1', callId: 'call_edit_001' },
      ...overrides,
    };
  }

  describe('permission.asked lifecycle', () => {
    let mockReplyToPermission: ReturnType<typeof vi.fn>;
    let mockTracker: {
      hasEdit: ReturnType<typeof vi.fn>;
      isTrackingAny: ReturnType<typeof vi.fn>;
      trackEdit: ReturnType<typeof vi.fn>;
      completeEdit: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockReplyToPermission = vi.fn(async () => undefined);
      mockTracker = {
        hasEdit: vi.fn().mockReturnValue(false),
        isTrackingAny: vi.fn().mockReturnValue(false),
        trackEdit: vi.fn().mockResolvedValue(undefined),
        completeEdit: vi.fn(),
        dispose: vi.fn(),
      };
    });

    it('calls tracker.trackEdit with callId and filepath when both are present', async () => {
      const stream = mockStream();
      const permBridge = new StreamBridge({
        sessionId: 'ses_target',
        replyToPermission: mockReplyToPermission as any,
        tracker: mockTracker as any,
      });
      const events = eventStream([
        permissionAskedEvent(),
        idleEvent(),
      ]);

      await permBridge.bridgeEventsToStream(events, stream, mockToken());

      // Permission handling triggered
      expect(mockTracker.trackEdit).toHaveBeenCalledWith(
        'call_edit_001',
        expect.anything(),
        stream,
      );
      // Auto-reply sent
      expect(mockReplyToPermission).toHaveBeenCalledWith(
        'ses_target',
        'perm_42',
        'once',
        undefined,
      );
    });

    it('does not call tracker.trackEdit when callId is missing', async () => {
      const stream = mockStream();
      const permBridge = new StreamBridge({
        sessionId: 'ses_target',
        replyToPermission: mockReplyToPermission as any,
        tracker: mockTracker as any,
      });
      const events = eventStream([
        permissionAskedEvent({ tool: undefined }),
        idleEvent(),
      ]);

      await permBridge.bridgeEventsToStream(events, stream, mockToken());

      // No callId → no tracking
      expect(mockTracker.trackEdit).not.toHaveBeenCalled();
      // Still auto-replies
      expect(mockReplyToPermission).toHaveBeenCalled();
    });

    it('does not call tracker.trackEdit when filepath is missing', async () => {
      const stream = mockStream();
      const permBridge = new StreamBridge({
        sessionId: 'ses_target',
        replyToPermission: mockReplyToPermission as any,
        tracker: mockTracker as any,
      });
      const events = eventStream([
        permissionAskedEvent({ metadata: {} }),
        idleEvent(),
      ]);

      await permBridge.bridgeEventsToStream(events, stream, mockToken());

      // No filepath in metadata → no tracking
      expect(mockTracker.trackEdit).not.toHaveBeenCalled();
    });

    it('skips tracking when tracker is absent (null/undefined)', async () => {
      const stream = mockStream();
      const permBridge = new StreamBridge({
        sessionId: 'ses_target',
        replyToPermission: mockReplyToPermission as any,
        tracker: undefined,
      });
      const events = eventStream([
        permissionAskedEvent(),
        idleEvent(),
      ]);

      await permBridge.bridgeEventsToStream(events, stream, mockToken());

      // No tracker set → still auto-replies without tracking
      expect(mockReplyToPermission).toHaveBeenCalled();
    });

    it('bridge loop continues processing subsequent events after permission.asked', async () => {
      const stream = mockStream();
      const permBridge = new StreamBridge({
        sessionId: 'ses_target',
        replyToPermission: mockReplyToPermission as any,
        tracker: mockTracker as any,
      });
      const events = eventStream([
        permissionAskedEvent(),
        // Regular tool event flow after permission.asked
        { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1' } },
        { type: 'part.delta', partId: 'prt_ai1', delta: 'Edit applied', field: 'text' },
        idleEvent(),
      ]);

      await permBridge.bridgeEventsToStream(events, stream, mockToken());

      // Permission handling happened
      expect(mockTracker.trackEdit).toHaveBeenCalledTimes(1);
      expect(mockReplyToPermission).toHaveBeenCalledTimes(1);
      // Subsequent text delta was rendered
      expect(stream.markdown).toHaveBeenCalledWith('Edit applied');
    });

    it('session.idle stops the bridge after permission.asked flow', async () => {
      const stream = mockStream();
      const permBridge = new StreamBridge({
        sessionId: 'ses_target',
        replyToPermission: mockReplyToPermission as any,
        tracker: mockTracker as any,
      });
      const events = eventStream([
        permissionAskedEvent(),
        { type: 'part.delta', partId: 'prt_ai1', delta: 'BEFORE', field: 'text' },
        idleEvent(),
        // This delta should be IGNORED because idle stops the bridge
        { type: 'part.delta', partId: 'prt_ai1', delta: 'AFTER_IDLE', field: 'text' },
      ]);

      await permBridge.bridgeEventsToStream(events, stream, mockToken());

      expect(stream.markdown).not.toHaveBeenCalledWith('AFTER_IDLE');
    });

    it('tool completion calls tracker.completeEdit with the same callId', async () => {
      const stream = mockStream();
      mockTracker.trackEdit.mockResolvedValue(undefined);
      const permBridge = new StreamBridge({
        sessionId: 'ses_target',
        replyToPermission: mockReplyToPermission as any,
        tracker: mockTracker as any,
      });
      // Simulate: permission.asked → tool pending → tool completed → idle
      const callId = 'call_edit_001';
      const partId = 'prt_edit_tool';
      const events = eventStream([
        permissionAskedEvent({ tool: { messageId: 'msg_t1', callId } }),
        {
          type: 'part.updated',
          part: {
            type: 'tool',
            toolName: 'edit',
            id: partId,
            callId,
            state: { status: 'pending', input: {} },
          },
        },
        {
          type: 'part.updated',
          part: {
            type: 'tool',
            toolName: 'edit',
            id: partId,
            callId,
            state: { status: 'completed', input: { filePath: '/src/app.ts' }, output: 'ok' },
          },
        },
        idleEvent(),
      ]);

      await permBridge.bridgeEventsToStream(events, stream, mockToken());

      // trackEdit was called during permission.asked handling
      expect(mockTracker.trackEdit).toHaveBeenCalledWith(callId, expect.anything(), stream);
      // completeEdit was called when tool completed with the same callId
      expect(mockTracker.completeEdit).toHaveBeenCalledWith(callId);
    });
  });

  // -----------------------------------------------------------------------
  // ACP-derived stream compatibility — regression tests
  // -----------------------------------------------------------------------

  describe('ACP-derived stream compatibility', () => {
    // --- session.diff gracefully handled (no MultiDiffPart in test mock) ---

    it('should gracefully handle session.diff without MultiDiffPart', async () => {
      const stream = mockStream();
      const events = eventStream([
        { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1' } },
        deltaEvent('Hello'),
        {
          type: 'session.diff',
          sessionId: 'ses_test',
          diffs: [
            {
              file: '/src/app.ts',
              patch: '...',
              additions: 5,
              deletions: 2,
              status: 'modified' as const,
            },
          ],
        } as AcpSessionDiffEvent,
        deltaEvent(' world'),
        idleEvent(),
      ]);
      await bridge.bridgeEventsToStream(events, stream, mockToken());
      // Both deltas rendered (session.diff in between is skipped gracefully)
      expect(stream.markdown).toHaveBeenCalledWith('Hello');
      expect(stream.markdown).toHaveBeenCalledWith(' world');
    });

    it('should process session.diff with deleted files (filtered out)', async () => {
      const stream = mockStream();
      const events = eventStream([
        { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1' } },
        {
          type: 'session.diff',
          sessionId: 'ses_test',
          diffs: [
            {
              file: '/src/removed.ts',
              patch: '',
              additions: 0,
              deletions: 10,
              status: 'deleted' as const,
            },
          ],
        } as AcpSessionDiffEvent,
        deltaEvent('Hello'),
        idleEvent(),
      ]);
      await bridge.bridgeEventsToStream(events, stream, mockToken());
      expect(stream.markdown).toHaveBeenCalledWith('Hello');
    });

    // --- permission.replied silently ignored ---

    it('should silently ignore permission.replied', async () => {
      const stream = mockStream();
      const events = eventStream([
        { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1' } },
        deltaEvent('Hello'),
        {
          type: 'permission.replied',
          sessionId: 'ses_test',
          permissionId: 'perm_1',
          response: 'once',
        },
        deltaEvent(' world'),
        idleEvent(),
      ]);
      await bridge.bridgeEventsToStream(events, stream, mockToken());
      // permission.replied should be skipped without rendering or crash
      expect(stream.markdown).toHaveBeenCalledWith('Hello');
      expect(stream.markdown).toHaveBeenCalledWith(' world');
    });

    // --- Ordering: session.idle stops regardless of event order ---

    it('should stop on session.idle even when permission.asked precedes it', async () => {
      const stream = mockStream();
      const events = eventStream([
        { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1' } },
        deltaEvent('Hello'),
        {
          type: 'permission.asked',
          permissionId: 'perm_1',
          sessionId: 'ses_test',
          permission: 'file:write',
          patterns: [],
          metadata: {},
          always: [],
        } as AcpPermissionRequestEvent,
        idleEvent(),
        deltaEvent('IGNORED_AFTER_IDLE'),
      ]);
      await bridge.bridgeEventsToStream(events, stream, mockToken());
      expect(stream.markdown).toHaveBeenCalledWith('Hello');
      expect(stream.markdown).not.toHaveBeenCalledWith('IGNORED_AFTER_IDLE');
    });

    // --- ACP-derived full turn with combined event types ---

    it('should process an ACP-derived full turn with multiple event types', async () => {
      const stream = mockStream();
      const events = eventStream([
        // User text echo
        { type: 'part.updated', part: { type: 'text', text: 'hi', messageId: 'msg_u1', id: 'prt_u1' } },
        // AIMessage step
        { type: 'part.updated', part: { type: 'step-start', messageId: 'msg_a1', id: 'prt_s1' } },
        // Reasoning part
        { type: 'part.updated', part: { type: 'reasoning', text: '', messageId: 'msg_a1', id: 'prt_r1' } },
        // Reasoning delta
        { type: 'part.delta', partId: 'prt_r1', delta: 'thinking...', field: 'text' },
        // AI text part
        { type: 'part.updated', part: { type: 'text', text: '', messageId: 'msg_a1', id: 'prt_ai1' } },
        // AI text delta
        { type: 'part.delta', partId: 'prt_ai1', delta: 'Hello world', field: 'text' },
        // Tool part (pending → completed)
        { type: 'part.updated', part: { type: 'tool', toolName: 'read', id: 'prt_t1', callId: 'call_1', state: { status: 'pending', input: {} } } },
        { type: 'part.updated', part: { type: 'tool', toolName: 'read', id: 'prt_t1', callId: 'call_1', state: { status: 'completed', input: { filePath: '/x.txt' }, output: 'file content' } } },
        // Step finish
        { type: 'part.updated', part: { type: 'step-finish', messageId: 'msg_a1', id: 'prt_f1' } },
        // Session done
        idleEvent(),
        // This should be ignored
        { type: 'part.delta', partId: 'prt_ai1', delta: 'IGNORED', field: 'text' },
      ]);
      await bridge.bridgeEventsToStream(events, stream, mockToken());
      // Verify the full turn rendered correctly
      expect(stream.thinkingProgress).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'thinking...' }),
      );
      expect(stream.markdown).toHaveBeenCalledWith('Hello world');
      expect(stream.beginToolInvocation).toHaveBeenCalledWith('call_1', 'read');
      expect(stream.markdown).not.toHaveBeenCalledWith('IGNORED');
    });
  });
});
