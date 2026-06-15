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
import type { ReasoningStreamPartPayload } from '../types';

export class ReasoningSSP extends SerializableStreamPart<
  'reasoning',
  ReasoningStreamPartPayload
> {
  readonly kind = 'reasoning' as const;

  constructor(payload: { partId: string; delta: string; messageId?: string }) {
    super({
      partId: payload.partId,
      text: payload.delta,
      messageId: payload.messageId,
    });
  }

  render(stream: SspStream): void {
    stream.thinkingProgress?.({ text: this.payload.text, id: this.payload.partId });
  }
}
