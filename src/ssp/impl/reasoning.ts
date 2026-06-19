/**
 * ReasoningSSP — append-only AI reasoning/thinking output (delta-driven).
 *
 * Kind: 'reasoning'
 *
 * Each push creates a new instance carrying a reasoning delta.
 * render() outputs the delta to stream.thinkingProgress().
 * No update() — this part is immutable after construction.
 * Silently skips when thinkingProgress is unavailable (no markdown degradation).
 */

import { SerializableStreamPart } from '../types';
import type { SspStream } from '../types';
import type { ReasoningStreamPartPayload, SerializableStreamPartMeta } from '../types';

export class ReasoningSSP extends SerializableStreamPart<
  'reasoning',
  ReasoningStreamPartPayload
> {
  readonly kind = 'reasoning' as const;

  constructor(
    payload: { partId: string; delta: string; messageId?: string; sessionId?: string },
    meta?: Partial<SerializableStreamPartMeta>,
    id?: string,
  ) {
    super({
      partId: payload.partId,
      text: payload.delta,
      messageId: payload.messageId,
      sessionId: payload.sessionId,
    }, {
      ...meta,
      sessionId: meta?.sessionId ?? payload.sessionId,
      sourcePartId: meta?.sourcePartId ?? payload.partId,
    }, id);
  }

  render(stream: SspStream): void {
    stream.thinkingProgress?.({ text: this.payload.text, id: this.payload.partId });
  }
}
