/**
 * QuestionSSP — mutable user interaction via questionCarousel.
 *
 * Kind: 'question'
 *
 * Lifecycle:
 *   push (status='asked') → render() shows questionCarousel
 *     → user answers → callbacks.onResult(vscodeRawResult)  ← Bridge maps format
 *     → user skips  → callbacks.onSkip()
 *     → payload.status updated to 'answered'/'skipped'
 *     → emitStateChange() → SSS writes metadata
 *
 *   update (status='replied'|'skipped') → no-op render (lifecycle guard)
 *
 * Guards:
 *   carouselShown: prevents re-launching questionCarousel on repeated render()
 */

import { SerializableStreamPart, IMutableStreamPart } from '../types';
import type { SerializableStreamPartMeta, SspStream, QuestionStreamPartPayload } from '../types';

export interface QuestionSSPCallbacks {
  /** Called with the RAW VS Code result — Bridge is responsible for format mapping */
  onResult: (vscodeRawResult: unknown) => void;
  /** Called when user skips / cancels */
  onSkip: () => void;
}

export class QuestionSSP extends SerializableStreamPart<
  'question',
  QuestionStreamPartPayload
> implements IMutableStreamPart<QuestionStreamPartPayload> {

  readonly kind = 'question' as const;
  private carouselShown = false;

  constructor(
    payload: QuestionStreamPartPayload,
    private readonly callbacks?: QuestionSSPCallbacks,
    meta?: Partial<SerializableStreamPartMeta>,
    id?: string,
  ) {
    super(payload, {
      ...meta,
      sourcePartId: meta?.sourcePartId ?? payload.questionId,
      toolCallId: meta?.toolCallId,
    }, id ?? payload.questionId);
  }

  render(stream: SspStream): void {
    if (this.carouselShown || this.payload.status !== 'asked') return;
    this.carouselShown = true;

    if (stream.questionCarousel) {
      stream.questionCarousel(this.payload.questions, true).then(
        (result) => {
          if (result === undefined) {
            this.payload.status = 'skipped';
            this.callbacks?.onSkip();
          } else {
            this.payload.status = 'replied';
            this.payload.answers = result;
            this.callbacks?.onResult(result);
          }
          this.emitStateChange();
        },
        () => {
          // questionCarousel rejected — treat as skip
          this.payload.status = 'skipped';
          this.callbacks?.onSkip();
          this.emitStateChange();
        },
      );
    } else {
      // Fallback: no questionCarousel API available
      // Bridge should handle fallback via its own logic
      this.payload.status = 'skipped';
      this.callbacks?.onSkip();
      this.emitStateChange();
    }
  }

  update(data: Partial<QuestionStreamPartPayload>): void {
    Object.assign(this.payload, data);
    // No emitStateChange — SSS handles render + append
  }
}
