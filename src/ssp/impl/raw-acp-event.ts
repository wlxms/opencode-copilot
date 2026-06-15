/**
 * RawAcpEventSSP — lossless fallback for unrecognized ACP events.
 *
 * Kind: 'rawAcpEvent'
 *
 * Any ACP event type not handled by a specific SSP gets wrapped here,
 * ensuring ZERO information loss. The entire event object is stored in
 * payload.event, so it can be reconstructed if needed.
 *
 * Render: no-op (we cannot predict how to render unknown events).
 */

import { SerializableStreamPart } from '../types';
import type { SspStream } from '../types';
import type { RawAcpEventStreamPartPayload } from '../types';

export class RawAcpEventSSP extends SerializableStreamPart<
  'rawAcpEvent',
  RawAcpEventStreamPartPayload
> {
  readonly kind = 'rawAcpEvent' as const;

  render(_stream: SspStream): void {
    // No-op: cannot predict how to render unknown events.
  }
}
