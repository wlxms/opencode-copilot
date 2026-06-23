import { describe, it, expect } from 'vitest';
import { GlobalEventBroker } from '../backends/opencode/event-broker';
import type { OpenCodeEvent, OpenCodeGlobalEventEnvelope } from '../backends/opencode/sdk-events';

function globalEvent(directory: string, payload: OpenCodeEvent): OpenCodeGlobalEventEnvelope {
  return { directory, payload };
}

function eventStream(events: OpenCodeGlobalEventEnvelope[]) {
  async function* gen(): AsyncIterable<OpenCodeGlobalEventEnvelope> {
    for (const event of events) {
      yield event;
    }
  }

  return { stream: gen() };
}

function mockClient(events: OpenCodeGlobalEventEnvelope[]) {
  let callCount = 0;
  return {
    global: {
      event: async () => {
        callCount++;
        if (callCount === 1) {
          return eventStream(events);
        }
        // On reconnect: throw to stop the pumpWithReconnect loop
        throw new Error('test: no reconnect');
      },
    },
  };
}

async function collectTypes(stream: AsyncIterable<OpenCodeGlobalEventEnvelope>, timeoutMs = 1000): Promise<string[]> {
  const types: string[] = [];
  const timer = setTimeout(() => stream[Symbol.asyncIterator]().return?.(), timeoutMs);
  try {
    for await (const event of stream) {
      types.push(event.payload.type);
    }
  } finally {
    clearTimeout(timer);
  }
  return types;
}

async function collectEvents(stream: AsyncIterable<OpenCodeGlobalEventEnvelope>, timeoutMs = 1000): Promise<OpenCodeGlobalEventEnvelope[]> {
  const events: OpenCodeGlobalEventEnvelope[] = [];
  const timer = setTimeout(() => stream[Symbol.asyncIterator]().return?.(), timeoutMs);
  try {
    for await (const event of stream) {
      events.push(event);
    }
  } finally {
    clearTimeout(timer);
  }
  return events;
}

describe('GlobalEventBroker', () => {
  it('should route only matching session events to a session stream', async () => {
    const broker = new GlobalEventBroker();
    const client = mockClient([
      globalEvent('dir', {
        type: 'message.part.updated',
        properties: {
          part: { type: 'text', id: 'prt_a', text: '', messageID: 'msg_a', sessionID: 'ses_a' },
        },
      }),
      globalEvent('dir', {
        type: 'message.part.updated',
        properties: {
          part: { type: 'text', id: 'prt_b', text: '', messageID: 'msg_b', sessionID: 'ses_b' },
        },
      }),
      globalEvent('dir', {
        type: 'message.part.delta',
        properties: { partID: 'prt_a', delta: 'A', field: 'text' },
      }),
      globalEvent('dir', {
        type: 'session.idle',
        properties: { sessionID: 'ses_a' },
      }),
      // Events after idle should still be delivered (channel stays open)
      globalEvent('dir', {
        type: 'message.part.updated',
        properties: {
          part: { type: 'tool', id: 'prt_tool', tool: 'bash', callID: 'call_1', state: { status: 'completed', input: { command: 'ls' }, output: 'ok' }, messageID: 'msg_c', sessionID: 'ses_a' },
        },
      }),
    ]);

    const sessionStream = broker.openSessionStream('ses_a');
    const started = broker.ensureStarted(client as never);
    started.catch(() => {}); // suppress unhandled rejection from reconnect error
    await started;
    const routed = await collectEvents(sessionStream.stream as AsyncIterable<OpenCodeGlobalEventEnvelope>);
    const types = routed.map(event => event.payload.type);

    // session.idle is delivered but does NOT close the stream
    // Subsequent tool event should also be delivered
    expect(types).toEqual([
      'message.part.updated',
      'message.part.delta',
      'session.idle',
      'message.part.updated',
    ]);
  });

  it('should resolve delta events to a session via tracked part ids', async () => {
    const broker = new GlobalEventBroker();
    const client = mockClient([
      globalEvent('dir', {
        type: 'message.part.updated',
        properties: {
          part: { type: 'reasoning', id: 'prt_reason', text: '', messageID: 'msg_a', sessionID: 'ses_a' },
        },
      }),
      globalEvent('dir', {
        type: 'message.part.delta',
        properties: { partID: 'prt_reason', delta: 'think', field: 'text' },
      }),
      globalEvent('dir', {
        type: 'session.idle',
        properties: { sessionID: 'ses_a' },
      }),
    ]);

    const sessionStream = broker.openSessionStream('ses_a');
    const started = broker.ensureStarted(client as never);
    started.catch(() => {}); // suppress unhandled rejection from reconnect error
    await started;
    const routed = await collectEvents(sessionStream.stream as AsyncIterable<OpenCodeGlobalEventEnvelope>);
    const types = routed.map(event => event.payload.type);

    expect(types).toEqual([
      'message.part.updated',
      'message.part.delta',
      'session.idle',
    ]);
    expect((routed[1].payload as any).properties.sessionID).toBe('ses_a');
  });
});
