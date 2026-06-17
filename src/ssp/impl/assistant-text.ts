/**
 * AssistantTextSSP — append-only AI text output (delta-driven).
 *
 * Kind: 'assistantText'
 *
 * Each push creates a new instance carrying a text delta.
 * render() outputs the delta to stream.markdown().
 * No update() — this part is immutable after construction.
 */

import { SerializableStreamPart } from '../types';
import type { SspStream } from '../types';
import type { AssistantTextStreamPartPayload, SerializableStreamPartMeta } from '../types';

export class AssistantTextSSP extends SerializableStreamPart<
  'assistantText',
  AssistantTextStreamPartPayload
> {
  readonly kind = 'assistantText' as const;

  constructor(
    payload: { partId: string; delta: string; messageId?: string },
    meta?: Partial<SerializableStreamPartMeta>,
    id?: string,
  ) {
    super({
      partId: payload.partId,
      text: payload.delta,
      messageId: payload.messageId,
    }, {
      ...meta,
      sourcePartId: meta?.sourcePartId ?? payload.partId,
    }, id);
  }

  render(stream: SspStream): void {
    stream.markdown(this.payload.text);
  }
}
