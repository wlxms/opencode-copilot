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
  return {
    global: {
      event: async () => eventStream(events),
    },
  };
}

async function collectTypes(stream: AsyncIterable<OpenCodeGlobalEventEnvelope>): Promise<string[]> {
  const types: string[] = [];
  for await (const event of stream) {
    types.push(event.payload.type);
  }
  return types;
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
    ]);

    const sessionStream = broker.openSessionStream('ses_a');
    await broker.ensureStarted(client as never);
    const types = await collectTypes(sessionStream.stream as AsyncIterable<OpenCodeGlobalEventEnvelope>);

    expect(types).toEqual([
      'message.part.updated',
      'message.part.delta',
      'session.idle',
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
    await broker.ensureStarted(client as never);
    const types = await collectTypes(sessionStream.stream as AsyncIterable<OpenCodeGlobalEventEnvelope>);

    expect(types).toEqual([
      'message.part.updated',
      'message.part.delta',
      'session.idle',
    ]);
  });
});