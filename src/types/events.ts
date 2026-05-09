/** Real SSE event types from the OpenCode server */

// Server lifecycle
export const EVENT_SERVER_CONNECTED = 'server.connected' as const;
export const EVENT_SERVER_HEARTBEAT = 'server.heartbeat' as const;

// Message events
export const EVENT_MESSAGE_UPDATED = 'message.updated' as const;
export const EVENT_MESSAGE_PART_UPDATED = 'message.part.updated' as const;
export const EVENT_MESSAGE_PART_DELTA = 'message.part.delta' as const;
export const EVENT_MESSAGE_REMOVED = 'message.removed' as const;

// Session events
export const EVENT_SESSION_CREATED = 'session.created' as const;
export const EVENT_SESSION_UPDATED = 'session.updated' as const;
export const EVENT_SESSION_DELETED = 'session.deleted' as const;
export const EVENT_SESSION_STATUS = 'session.status' as const;
export const EVENT_SESSION_DIFF = 'session.diff' as const;
export const EVENT_SESSION_ERROR = 'session.error' as const;
export const EVENT_SESSION_IDLE = 'session.idle' as const;

/** All known real event type strings */
export type RealEventType =
  | typeof EVENT_SERVER_CONNECTED
  | typeof EVENT_SERVER_HEARTBEAT
  | typeof EVENT_MESSAGE_UPDATED
  | typeof EVENT_MESSAGE_PART_UPDATED
  | typeof EVENT_MESSAGE_PART_DELTA
  | typeof EVENT_MESSAGE_REMOVED
  | typeof EVENT_SESSION_CREATED
  | typeof EVENT_SESSION_UPDATED
  | typeof EVENT_SESSION_DELETED
  | typeof EVENT_SESSION_STATUS
  | typeof EVENT_SESSION_DIFF
  | typeof EVENT_SESSION_ERROR
  | typeof EVENT_SESSION_IDLE;

/**
 * Part types in message.part.updated events.
 *
 * Event flow for a chat turn:
 * 1. type=text (user echo)       → full prompt text, first messageID
 * 2. type=step-start             → step/tool begins (new messageID)
 * 3. type=reasoning              → reasoning part (empty, then delta stream)
 * 4. type=tool                   → tool call (pending → running → completed)
 * 5. type=text (AI response)     → AI text part (empty, then delta stream)
 * 6. type=step-finish            → step done
 * 7. session.idle                → turn complete
 */
export type PartType =
  | 'text'
  | 'reasoning'
  | 'tool'
  | 'tool_use'
  | 'tool_result'
  | 'step-start'
  | 'step-finish';

/**
 * Tool call status progression in message.part.updated type=tool events:
 * - state.status: "pending" → "running" → "completed"
 * - state.input: tool parameters (on running/completed)
 * - state.output: tool result (on completed)
 * - state.title: display name (on completed)
 */
export type ToolCallStatus = 'pending' | 'running' | 'completed';
