import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { StreamBridge } from '../participant/streaming';
import type { MessagePartDeltaEvent, OpenCodeEvent, PermissionAskedEvent, SessionDiffEvent, SessionIdleEvent, StreamToolPart } from '../types/events';

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

  it('should push read tool as ChatSimpleToolResultData', async () => {
    const stream = mockStream();
    const events = eventStream(fullTurnEvents({
      tools: toolEvents({ toolName: 'read', callID: 'call_rd', input: { filePath: '/src/main.ts' }, output: 'line1\nline2', title: 'main.ts', timeStart: 1000, timeEnd: 1500 }),
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
      tools: toolEvents({ toolName: 'bash', callID: 'call_sh', input: { command: 'ls -la' }, output: 'total 42', title: 'bash', timeStart: 1000, timeEnd: 3200 }),
    }));
    await bridge.bridgeEventsToStream(events, stream, mockToken());
    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(pushed.toolSpecificData.commandLine.original).toBe('ls -la');
    expect(pushed.toolSpecificData.output.text).toContain('total 42');
    expect(pushed.pastTenseMessage).toMatch(/Ran bash.*2\.2s/);
  });

  // --- Tool: write with filePath → ToolResourcesData ---

  it('should push write tool with filePath as ChatToolResourcesInvocationData', async () => {
    const stream = mockStream();
    const events = eventStream(fullTurnEvents({
      tools: toolEvents({ toolName: 'write', callID: 'call_wr', input: { filePath: '/src/new.ts', content: 'x' }, output: 'ok', title: 'new.ts' }),
    }));
    await bridge.bridgeEventsToStream(events, stream, mockToken());
    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(pushed.toolSpecificData.values).toBeDefined();
  });

  // --- Tool: task/subagent → SubagentToolData ---

  it('should push subagent tool as ChatSubagentToolInvocationData', async () => {
    const stream = mockStream();
    const events = eventStream(fullTurnEvents({
      tools: toolEvents({ toolName: 'task', callID: 'call_sub', input: { agentName: 'code-search', prompt: 'Find foo()' }, output: 'Found 5', title: 'search' }),
    }));
    await bridge.bridgeEventsToStream(events, stream, mockToken());
    const pushed = (stream.push as ReturnType<typeof vi.fn>).mock.calls[1][0];
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
    expect(stream.push).toHaveBeenCalledTimes(4);
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
    expect((s2.push as ReturnType<typeof vi.fn>).mock.calls[1][0].toolSpecificData.output).toBe('b');
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

  // -----------------------------------------------------------------------
  // Permission.asked lifecycle — external edit tracking + auto-reply
  // -----------------------------------------------------------------------
  function permissionAskedEvent(
    overrides?: Partial<PermissionAskedEvent['properties']>,
  ): PermissionAskedEvent {
    return {
      type: 'permission.asked',
      properties: {
        id: 'perm_42',
        sessionID: 'ses_target',
        permission: 'edit',
        patterns: ['src/**/*.ts'],
        metadata: { filepath: '/workspace/src/app.ts' },
        always: [],
        tool: { messageID: 'msg_tool1', callID: 'call_edit_001' },
        ...overrides,
      },
    };
  }

  describe('permission.asked lifecycle', () => {
    let mockClient: {
      postSessionIdPermissionsPermissionId: ReturnType<typeof vi.fn>;
    };
    let mockTracker: {
      hasEdit: ReturnType<typeof vi.fn>;
      isTrackingAny: ReturnType<typeof vi.fn>;
      trackEdit: ReturnType<typeof vi.fn>;
      completeEdit: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockClient = {
        postSessionIdPermissionsPermissionId: vi.fn().mockResolvedValue(undefined),
      };
      mockTracker = {
        hasEdit: vi.fn().mockReturnValue(false),
        isTrackingAny: vi.fn().mockReturnValue(false),
        trackEdit: vi.fn().mockResolvedValue(undefined),
        completeEdit: vi.fn(),
        dispose: vi.fn(),
      };
    });

    it('calls tracker.trackEdit with callID and filepath when both are present', async () => {
      const stream = mockStream();
      const permBridge = new StreamBridge({
        sessionId: 'ses_target',
        client: mockClient as any,
        tracker: mockTracker as any,
      });
      const events = eventStream([
        permissionAskedEvent(),
        idleEvent(),
      ]);

      await permBridge.bridgeEventsToStream(events, stream, mockToken());

      expect(mockTracker.trackEdit).toHaveBeenCalledTimes(1);
      expect(mockTracker.trackEdit).toHaveBeenCalledWith(
        'call_edit_001',
        expect.arrayContaining([
          expect.objectContaining({ path: expect.stringContaining('src/app.ts') }),
        ]),
        stream,
      );
    });

    it('auto-replies "once" after trackEdit resolves', async () => {
      const stream = mockStream();
      // trackEdit resolves before auto-reply — use sequential mock to verify ordering
      let trackEditResolved = false;
      mockTracker.trackEdit.mockImplementation(async () => {
        await Promise.resolve();
        trackEditResolved = true;
      });
      mockClient.postSessionIdPermissionsPermissionId.mockImplementation(async () => {
        expect(trackEditResolved).toBe(true);
      });

      const permBridge = new StreamBridge({
        sessionId: 'ses_target',
        client: mockClient as any,
        tracker: mockTracker as any,
      });
      const events = eventStream([
        permissionAskedEvent(),
        idleEvent(),
      ]);

      await permBridge.bridgeEventsToStream(events, stream, mockToken());

      expect(mockTracker.trackEdit).toHaveBeenCalledTimes(1);
      expect(mockClient.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1);
      expect(mockClient.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { id: 'ses_target', permissionID: 'perm_42' },
          body: { response: 'once' },
        }),
      );
    });

    it('does not render visual output for permission.asked', async () => {
      const stream = mockStream();
      const permBridge = new StreamBridge({
        sessionId: 'ses_target',
        client: mockClient as any,
        tracker: mockTracker as any,
      });
      const events = eventStream([
        permissionAskedEvent(),
        idleEvent(),
      ]);

      await permBridge.bridgeEventsToStream(events, stream, mockToken());

      expect(stream.markdown).not.toHaveBeenCalled();
      expect(stream.progress).not.toHaveBeenCalled();
      expect(stream.push).not.toHaveBeenCalled();
    });

    it('skips trackEdit when callID is missing', async () => {
      const stream = mockStream();
      const permBridge = new StreamBridge({
        sessionId: 'ses_target',
        client: mockClient as any,
        tracker: mockTracker as any,
      });
      const events = eventStream([
        permissionAskedEvent({ tool: { messageID: 'msg_t1', callID: '' } }),
        idleEvent(),
      ]);

      await permBridge.bridgeEventsToStream(events, stream, mockToken());

      expect(mockTracker.trackEdit).not.toHaveBeenCalled();
      // Auto-reply should still fire
      expect(mockClient.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1);
    });

    it('skips trackEdit when filepath is missing from metadata', async () => {
      const stream = mockStream();
      const permBridge = new StreamBridge({
        sessionId: 'ses_target',
        client: mockClient as any,
        tracker: mockTracker as any,
      });
      const events = eventStream([
        permissionAskedEvent({ metadata: { filepath: undefined } }),
        idleEvent(),
      ]);

      await permBridge.bridgeEventsToStream(events, stream, mockToken());

      expect(mockTracker.trackEdit).not.toHaveBeenCalled();
      expect(mockClient.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1);
    });

    it('skips auto-reply when client is not provided', async () => {
      const stream = mockStream();
      const permBridge = new StreamBridge({
        sessionId: 'ses_target',
        tracker: mockTracker as any,
        // no client
      });
      const events = eventStream([
        permissionAskedEvent(),
        idleEvent(),
      ]);

      await permBridge.bridgeEventsToStream(events, stream, mockToken());

      // trackEdit should still be called
      expect(mockTracker.trackEdit).toHaveBeenCalledTimes(1);
      // auto-reply should NOT be called
      expect(mockClient.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled();
    });

    it('does not double-track an already-tracked callID', async () => {
      const stream = mockStream();
      mockTracker.hasEdit.mockReturnValue(true); // already tracked
      const permBridge = new StreamBridge({
        sessionId: 'ses_target',
        client: mockClient as any,
        tracker: mockTracker as any,
      });
      const events = eventStream([
        permissionAskedEvent(),
        idleEvent(),
      ]);

      await permBridge.bridgeEventsToStream(events, stream, mockToken());

      expect(mockTracker.trackEdit).not.toHaveBeenCalled();
      expect(mockTracker.hasEdit).toHaveBeenCalledWith('call_edit_001');
      // Auto-reply should still fire
      expect(mockClient.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1);
    });

    it('does not track when file already has an active externalEditPart', async () => {
      const stream = mockStream();
      mockTracker.isTrackingAny.mockReturnValue(true); // file already tracked
      const permBridge = new StreamBridge({
        sessionId: 'ses_target',
        client: mockClient as any,
        tracker: mockTracker as any,
      });
      const events = eventStream([
        permissionAskedEvent(),
        idleEvent(),
      ]);

      await permBridge.bridgeEventsToStream(events, stream, mockToken());

      expect(mockTracker.trackEdit).not.toHaveBeenCalled();
    });

    it('bridge loop continues processing subsequent events after permission.asked', async () => {
      const stream = mockStream();
      const permBridge = new StreamBridge({
        sessionId: 'ses_target',
        client: mockClient as any,
        tracker: mockTracker as any,
      });
      const events = eventStream([
        permissionAskedEvent(),
        // Regular tool event flow after permission.asked
        { type: 'message.part.updated', properties: { part: { type: 'text', text: '', messageID: 'msg_a1', id: 'prt_ai1' } } },
        { type: 'message.part.delta', properties: { partID: 'prt_ai1', delta: 'Edit applied', field: 'text' } },
        idleEvent(),
      ]);

      await permBridge.bridgeEventsToStream(events, stream, mockToken());

      // Permission handling happened
      expect(mockTracker.trackEdit).toHaveBeenCalledTimes(1);
      expect(mockClient.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1);
      // Subsequent text delta was rendered
      expect(stream.markdown).toHaveBeenCalledWith('Edit applied');
    });

    it('session.idle stops the bridge after permission.asked flow', async () => {
      const stream = mockStream();
      const permBridge = new StreamBridge({
        sessionId: 'ses_target',
        client: mockClient as any,
        tracker: mockTracker as any,
      });
      const events = eventStream([
        permissionAskedEvent(),
        { type: 'message.part.delta', properties: { partID: 'prt_ai1', delta: 'BEFORE', field: 'text' } },
        idleEvent(),
        // This delta should be IGNORED because idle stops the bridge
        { type: 'message.part.delta', properties: { partID: 'prt_ai1', delta: 'AFTER_IDLE', field: 'text' } },
      ]);

      await permBridge.bridgeEventsToStream(events, stream, mockToken());

      expect(stream.markdown).not.toHaveBeenCalledWith('AFTER_IDLE');
    });

    it('tool completion calls tracker.completeEdit with the same callID', async () => {
      const stream = mockStream();
      mockTracker.trackEdit.mockResolvedValue(undefined);
      const permBridge = new StreamBridge({
        sessionId: 'ses_target',
        client: mockClient as any,
        tracker: mockTracker as any,
      });
      // Simulate: permission.asked → tool pending → tool completed → idle
      const callID = 'call_edit_001';
      const partId = 'prt_edit_tool';
      const events = eventStream([
        permissionAskedEvent({ tool: { messageID: 'msg_t1', callID } }),
        {
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'tool',
              tool: 'edit',
              id: partId,
              callID,
              state: { status: 'pending', input: {} },
            },
          },
        },
        {
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'tool',
              tool: 'edit',
              id: partId,
              callID,
              state: { status: 'completed', input: { filePath: '/src/app.ts' }, output: 'ok' },
            },
          },
        },
        idleEvent(),
      ]);

      await permBridge.bridgeEventsToStream(events, stream, mockToken());

      // trackEdit was called during permission.asked handling
      expect(mockTracker.trackEdit).toHaveBeenCalledWith(callID, expect.anything(), stream);
      // completeEdit was called when tool completed with the same callID
      expect(mockTracker.completeEdit).toHaveBeenCalledWith(callID);
    });
  });

  // -----------------------------------------------------------------------
  // ACP-derived stream compatibility — regression tests
  // for events produced by denormalizeAcpEvent in handler.ts
  // -----------------------------------------------------------------------

  describe('ACP-derived stream compatibility', () => {
    // --- session.diff gracefully handled (no MultiDiffPart in test mock) ---

    it('should gracefully handle session.diff without MultiDiffPart', async () => {
      const stream = mockStream();
      const events = eventStream([
        { type: 'message.part.updated', properties: { part: { type: 'text', text: '', messageID: 'msg_a1', id: 'prt_ai1' } } },
        deltaEvent('Hello'),
        {
          type: 'session.diff',
          properties: {
            sessionID: 'ses_test',
            diff: [
              {
                file: '/src/app.ts',
                patch: '...',
                additions: 5,
                deletions: 2,
                status: 'modified' as const,
              },
            ],
          },
        } as SessionDiffEvent,
        deltaEvent(' world'),
        idleEvent(),
      ]);
      await bridge.bridgeEventsToStream(events, stream, mockToken());
      // session.diff should not crash; subsequent events still processed
      expect(stream.markdown).toHaveBeenCalledWith('Hello');
      expect(stream.markdown).toHaveBeenCalledWith(' world');
      expect(stream.push).not.toHaveBeenCalled();
    });

    it('should handle session.diff with empty diff array', async () => {
      const stream = mockStream();
      const events = eventStream([
        { type: 'message.part.updated', properties: { part: { type: 'text', text: '', messageID: 'msg_a1', id: 'prt_ai1' } } },
        {
          type: 'session.diff',
          properties: {
            sessionID: 'ses_test',
            diff: [],
          },
        } as SessionDiffEvent,
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
        { type: 'message.part.updated', properties: { part: { type: 'text', text: '', messageID: 'msg_a1', id: 'prt_ai1' } } },
        deltaEvent('Hello'),
        {
          type: 'permission.replied',
          properties: {
            sessionID: 'ses_test',
            permissionID: 'perm_1',
            response: 'once',
          },
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
        { type: 'message.part.updated', properties: { part: { type: 'text', text: '', messageID: 'msg_a1', id: 'prt_ai1' } } },
        deltaEvent('Hello'),
        {
          type: 'permission.asked',
          properties: {
            id: 'perm_1',
            sessionID: 'ses_test',
            permission: 'file:write',
            patterns: [],
            metadata: {},
            always: [],
          },
        } as PermissionAskedEvent,
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
        { type: 'message.part.updated', properties: { part: { type: 'text', text: 'hi', messageID: 'msg_u1', id: 'prt_u1' } } },
        // AIMessage step
        { type: 'message.part.updated', properties: { part: { type: 'step-start', messageID: 'msg_a1', id: 'prt_s1' } } },
        // Reasoning part
        { type: 'message.part.updated', properties: { part: { type: 'reasoning', text: '', messageID: 'msg_a1', id: 'prt_r1' } } },
        // Reasoning delta
        { type: 'message.part.delta', properties: { partID: 'prt_r1', delta: 'thinking...', field: 'text' } },
        // AI text part
        { type: 'message.part.updated', properties: { part: { type: 'text', text: '', messageID: 'msg_a1', id: 'prt_ai1' } } },
        // AI text delta
        { type: 'message.part.delta', properties: { partID: 'prt_ai1', delta: 'Hello world', field: 'text' } },
        // Tool part (pending → running → completed)
        { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'read', id: 'prt_t1', callID: 'call_1', state: { status: 'pending', input: {} } } } },
        { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'read', id: 'prt_t1', callID: 'call_1', state: { status: 'completed', input: { filePath: '/x.txt' }, output: 'file content' } } } },
        // Step finish
        { type: 'message.part.updated', properties: { part: { type: 'step-finish', messageID: 'msg_a1', id: 'prt_f1' } } },
        // Session done
        idleEvent(),
        // This should be ignored
        { type: 'message.part.delta', properties: { partID: 'prt_ai1', delta: 'IGNORED', field: 'text' } },
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
