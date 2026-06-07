import { describe, expect, it } from 'vitest';
import { normalizeEvent } from '../backends/opencode/events';

describe('OpenCode event normalization', () => {
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
});
