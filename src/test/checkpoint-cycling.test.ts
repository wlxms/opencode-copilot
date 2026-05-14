import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { Gate } from '../participant/gate';
import { StreamBridge } from '../participant/streaming';
import type { OpenCodeEvent, SessionIdleEvent } from '../types/events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockStream = vscode.ChatResponseStream & {
  thinkingProgress: ReturnType<typeof vi.fn>;
  beginToolInvocation: ReturnType<typeof vi.fn>;
  updateToolInvocation: ReturnType<typeof vi.fn>;
};

function mockStream(): MockStream {
  const stream: Partial<MockStream> = {
    markdown: vi.fn(),
    progress: vi.fn(),
    push: vi.fn(),
    thinkingProgress: vi.fn(),
    beginToolInvocation: vi.fn(),
    updateToolInvocation: vi.fn(),
  };
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

function idleEvent(): SessionIdleEvent {
  return { type: 'session.idle', properties: {} };
}

// ---------------------------------------------------------------------------
// Test 1: Gate resolved property
// ---------------------------------------------------------------------------

describe('Gate resolved property', () => {
  it('creates resolved/unresolved correctly — fresh gate is unresolved, resolved after resolve()', () => {
    const gate = new Gate(Infinity);
    expect(gate.resolved).toBe(false);

    gate.resolve();
    expect(gate.resolved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests 2-5: onCheckpointCycle callback behavior
// ---------------------------------------------------------------------------

describe('onCheckpointCycle callback', () => {
  // -----------------------------------------------------------------------
  // Test 2: permission boundary (permission mode)
  // -----------------------------------------------------------------------

  it('is invoked at permission.asked boundary in permission mode', async () => {
    const stream = mockStream();
    const onCheckpointCycle = vi.fn();
    const bridge = new StreamBridge({
      checkpointMode: 'permission',
      onCheckpointCycle,
    });

    const permEvent: OpenCodeEvent = {
      type: 'permission.asked',
      properties: {
        id: 'perm_1',
        sessionID: 'ses_1',
        permission: 'edit',
        patterns: ['/f.txt'],
        metadata: {},
        always: [],
        tool: { messageID: 'msg_1', callID: 'call_1' },
      },
    };

    const partId = 'prt_edit1';
    const events = eventStream([
      { type: 'message.part.updated', properties: { part: { type: 'step-start', messageID: 'msg_a1', id: 'prt_s1' } } },
      permEvent,
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'edit',
            id: partId,
            callID: 'call_1',
            state: { status: 'running', input: { filePath: '/f.txt' } },
          },
        },
      },
      idleEvent(),
    ]);
    await bridge.bridgeEventsToStream(events, stream, mockToken());

    // Signal fires when edit permission is requested, before approval resumes the edit.
    expect(onCheckpointCycle).toHaveBeenCalledTimes(1);
  });

  it('is invoked again at tool.completed boundary in permission mode', async () => {
    const stream = mockStream();
    const onCheckpointCycle = vi.fn();
    const bridge = new StreamBridge({
      checkpointMode: 'permission',
      onCheckpointCycle,
      onPermissionAsked: vi.fn(),
    });

    const partId = 'prt_edit_complete';
    const events = eventStream([
      { type: 'message.part.updated', properties: { part: { type: 'step-start', messageID: 'msg_a1', id: 'prt_s1' } } },
      {
        type: 'permission.asked',
        properties: {
          id: 'perm_1',
          sessionID: 'ses_1',
          permission: 'edit',
          patterns: ['/f.txt'],
          metadata: { filePath: '/f.txt' },
          always: [],
          tool: { messageID: 'msg_1', callID: 'call_1' },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'edit',
            id: partId,
            callID: 'call_1',
            state: {
              status: 'running',
              input: { filePath: '/f.txt' },
            },
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
            callID: 'call_1',
            state: {
              status: 'completed',
              input: { filePath: '/f.txt' },
              output: 'ok',
            },
          },
        },
      },
      idleEvent(),
    ]);

    await bridge.bridgeEventsToStream(events, stream, mockToken());

    expect(onCheckpointCycle).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // Test 3: tool.running boundary, edit tool, message mode
  // -----------------------------------------------------------------------

  it('is invoked at tool.completed boundary (checkpointMode=message, tool=edit)', async () => {
    const stream = mockStream();
    const onCheckpointCycle = vi.fn();
    const bridge = new StreamBridge({
      checkpointMode: 'message',
      onCheckpointCycle,
    });

    const partId = 'prt_t1';
    const events = eventStream([
      {
        type: 'message.part.updated',
        properties: { part: { type: 'text', text: 'edit it', messageID: 'msg_u1', id: 'prt_u1' } },
      },
      {
        type: 'message.part.updated',
        properties: { part: { type: 'step-start', messageID: 'msg_a1', id: 'prt_s1' } },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'edit',
            id: partId,
            callID: 'call_1',
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
            callID: 'call_1',
            state: {
              status: 'running',
              input: { filePath: '/f.txt' },
            },
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
            callID: 'call_1',
            state: {
              status: 'completed',
              input: { filePath: '/f.txt' },
              output: 'ok',
            },
          },
        },
      },
      { type: 'message.part.updated', properties: { part: { type: 'text', text: '', messageID: 'msg_a1', id: 'prt_ai1' } } },
      idleEvent(),
    ]);

    await bridge.bridgeEventsToStream(events, stream, mockToken());

    // Signal fires once at tool.running (not at completed — avoids +0 -0 records)
    expect(onCheckpointCycle).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Test 4: non-edit tool, message mode — should NOT invoke
  // -----------------------------------------------------------------------

  it('is NOT called for non-edit/write tools (checkpointMode=message, tool=read)', async () => {
    const stream = mockStream();
    const onCheckpointCycle = vi.fn();
    const bridge = new StreamBridge({
      checkpointMode: 'message',
      onCheckpointCycle,
    });

    const partId = 'prt_t1';
    const events = eventStream([
      {
        type: 'message.part.updated',
        properties: { part: { type: 'text', text: 'read it', messageID: 'msg_u1', id: 'prt_u1' } },
      },
      {
        type: 'message.part.updated',
        properties: { part: { type: 'step-start', messageID: 'msg_a1', id: 'prt_s1' } },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'read',
            id: partId,
            callID: 'call_1',
            state: { status: 'pending', input: {} },
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'read',
            id: partId,
            callID: 'call_1',
            state: {
              status: 'completed',
              input: { filePath: '/f.txt' },
              output: 'content lines',
            },
          },
        },
      },
      { type: 'message.part.updated', properties: { part: { type: 'text', text: '', messageID: 'msg_a1', id: 'prt_ai1' } } },
      idleEvent(),
    ]);

    await bridge.bridgeEventsToStream(events, stream, mockToken());

    expect(onCheckpointCycle).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test 5: turn mode — tool.completed should NOT invoke callback
  // -----------------------------------------------------------------------

  it('is NOT called in turn mode (checkpointMode=turn, tool=edit completed)', async () => {
    const stream = mockStream();
    const onCheckpointCycle = vi.fn();
    const bridge = new StreamBridge({
      checkpointMode: 'turn',
      onCheckpointCycle,
    });

    const partId = 'prt_t1';
    const events = eventStream([
      {
        type: 'message.part.updated',
        properties: { part: { type: 'text', text: 'edit it', messageID: 'msg_u1', id: 'prt_u1' } },
      },
      {
        type: 'message.part.updated',
        properties: { part: { type: 'step-start', messageID: 'msg_a1', id: 'prt_s1' } },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'edit',
            id: partId,
            callID: 'call_1',
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
            callID: 'call_1',
            state: {
              status: 'completed',
              input: { filePath: '/f.txt' },
              output: 'ok',
            },
          },
        },
      },
      { type: 'message.part.updated', properties: { part: { type: 'text', text: '', messageID: 'msg_a1', id: 'prt_ai1' } } },
      idleEvent(),
    ]);

    await bridge.bridgeEventsToStream(events, stream, mockToken());

    // In 'turn' mode the handler passes onCheckpointCycle=undefined, so the
    // tool.completed branch skips the callback regardless of checkpoint mode.
    // With onCheckpointCycle defined here, the code would only call it if
    // checkpointMode === 'message', which it is not.
    expect(onCheckpointCycle).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 6: cycleCheckpoint Gate lifecycle (handler pattern)
// ---------------------------------------------------------------------------

describe('cycleCheckpoint Gate lifecycle', () => {
  it('creates independent Gate objects across multiple cycles', () => {
    // Replicate the handler's cycleCheckpoint pattern:
    //   - resolve the old gate
    //   - create a new gate for the next cycle
    let currentGate: Gate;
    const cycleCheckpoint = (): void => {
      currentGate.resolve();
      currentGate = new Gate(Infinity);
    };

    currentGate = new Gate(Infinity);
    expect(currentGate.resolved).toBe(false);

    // --- First cycle ---
    const gate1 = currentGate;
    cycleCheckpoint();

    expect(gate1.resolved).toBe(true);           // old gate resolved
    expect(currentGate.resolved).toBe(false);     // new gate unresolved
    expect(currentGate).not.toBe(gate1);           // distinct reference

    // --- Second cycle ---
    const gate2 = currentGate;
    cycleCheckpoint();

    expect(gate2.resolved).toBe(true);            // second old gate resolved
    expect(currentGate.resolved).toBe(false);      // second new gate unresolved
    expect(currentGate).not.toBe(gate2);            // distinct reference

    // All three references are distinct objects
    expect(gate1).not.toBe(gate2);
    expect(gate2).not.toBe(currentGate);
  });
});
