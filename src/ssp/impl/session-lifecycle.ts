/**
 * SessionLifecycleSSP — records session lifecycle events (created/updated/idle/error).
 * Kind: 'sessionLifecycle'
 * Render: progress message (lightweight UI feedback).
 */

import { SerializableStreamPart } from '../types';
import type { SspStream } from '../types';
import type {
  SerializableStreamPartMeta,
  SessionLifecycleStreamPartPayload,
  SessionDiffStreamPartPayload,
} from '../types';

export class SessionLifecycleSSP extends SerializableStreamPart<
  'sessionLifecycle',
  SessionLifecycleStreamPartPayload
> {
  readonly kind = 'sessionLifecycle' as const;

  constructor(
    payload: SessionLifecycleStreamPartPayload,
    meta?: Partial<SerializableStreamPartMeta>,
    id?: string,
  ) {
    super(payload, meta, id);
  }

  render(stream: SspStream): void {
    if (this.payload.eventType === 'session.error' && this.payload.error) {
      stream.progress(`⚠️ ${this.payload.error}`);
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * SessionDiffSSP — append-only session.diff records (file changes).
 * Kind: 'sessionDiff'
 * Render: no-op (diffs are persisted for checkpoint/undo, not rendered in chat).
 */

export class SessionDiffSSP extends SerializableStreamPart<
  'sessionDiff',
  SessionDiffStreamPartPayload
> {
  readonly kind = 'sessionDiff' as const;

  constructor(
    payload: SessionDiffStreamPartPayload,
    meta?: Partial<SerializableStreamPartMeta>,
    id?: string,
  ) {
    super(payload, meta, id);
  }

  render(_stream: SspStream): void {
    // No-op: diffs are persisted for checkpoint/undo, not rendered.
  }
}
