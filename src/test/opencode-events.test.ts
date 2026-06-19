import { describe, expect, it } from 'vitest';
import { normalizeEvent } from '../backends/opencode/events';

describe('OpenCode event normalization', () => {
  it('normalizes session parentID hints for child sessions', () => {
    const events = normalizeEvent({
      type: 'session.created',
      properties: {
        info: {
          id: 'ses_child',
          parentID: 'ses_parent',
          title: 'child task',
        },
      },
    } as any);

    expect(events).toEqual([
      {
        type: 'session.created',
        sessionId: 'ses_child',
        parentId: 'ses_parent',
        title: 'child task',
      },
    ]);
  });

  it('formats object-shaped session.error payloads from OpenCode', () => {
    const events = normalizeEvent({
      type: 'session.error',
      properties: {
        sessionID: 'ses_error',
        error: {
          name: 'UnknownError',
          data: {
            message: 'SQLiteError: NOT NULL constraint failed: session_message.seq',
          },
        },
      },
    } as any);

    expect(events).toEqual([
      {
        type: 'session.error',
        sessionId: 'ses_error',
        error: 'SQLiteError: NOT NULL constraint failed: session_message.seq',
      },
    ]);
  });

  it('preserves broker-resolved sessionID on message.part.delta events', () => {
    const events = normalizeEvent({
      type: 'message.part.delta',
      properties: {
        sessionID: 'ses_child',
        partID: 'prt_child_text',
        delta: 'child text',
        field: 'text',
      },
    } as any);

    expect(events).toEqual([
      {
        type: 'part.delta',
        sessionId: 'ses_child',
        partId: 'prt_child_text',
        delta: 'child text',
        field: 'text',
      },
    ]);
  });

  it('promotes part sessionID to event-level sessionId on message.part.updated events', () => {
    const events = normalizeEvent({
      type: 'message.part.updated',
      properties: {
        part: {
          type: 'text',
          id: 'prt_child_text',
          messageID: 'msg_child',
          sessionID: 'ses_child',
          text: 'child text',
        },
      },
    } as any);

    expect(events).toEqual([
      {
        type: 'part.updated',
        sessionId: 'ses_child',
        part: {
          type: 'text',
          id: 'prt_child_text',
          messageId: 'msg_child',
          sessionId: 'ses_child',
          text: 'child text',
          synthetic: undefined,
        },
        delta: undefined,
      },
    ]);
  });
});
