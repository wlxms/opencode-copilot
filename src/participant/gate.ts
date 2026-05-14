/**
 * A deferred promise with timeout that auto-resolves after the specified duration.
 *
 * Used as a synchronization primitive to signal when work should proceed.
 * Unlike a traditional deferred, Gate auto-resolves on timeout instead of
 * throwing, providing a safe fallback for continuation flows (e.g., SSE loops).
 */
export class Gate {
  private _resolve: (() => void) | null = null;
  private _resolved = false;
  private _promise: Promise<void>;
  private _timer: ReturnType<typeof setTimeout> | undefined;
  private _logger?: (msg: string) => void;

  /**
   * Creates a new Gate.
   *
   * @param timeoutMs - Timeout in milliseconds before the gate auto-resolves.
   *                    Defaults to 30000 (30 seconds). Pass `Infinity` to disable.
   * @param logger - Optional callback for timeout/debug logging.
   */
  constructor(timeoutMs: number = 30000, logger?: (msg: string) => void) {
    this._logger = logger;

    this._promise = new Promise<void>((resolve) => {
      this._resolve = resolve;
    });

    if (timeoutMs !== Infinity && timeoutMs > 0) {
      this._timer = setTimeout(() => {
        if (!this._resolved) {
          this._logger?.(`Gate timeout after ${timeoutMs}ms — auto-resolving`);
          this._resolveInternal();
        }
      }, timeoutMs);
    }
  }

  /**
   * Returns `true` if the gate has been resolved (including auto-resolve on timeout).
   */
  get resolved(): boolean {
    return this._resolved;
  }

  /**
   * The deferred promise. Await this to block until the gate is resolved.
   */
  get promise(): Promise<void> {
    return this._promise;
  }

  /**
   * Resolves the gate, unblocking any awaiter.
   *
   * Idempotent — calling `resolve()` multiple times is safe; subsequent calls
   * are no-ops after the first resolution.
   */
  resolve(): void {
    if (this._resolved) return;
    this._resolveInternal();
  }

  /**
   * Disposes the gate: resolves if not yet resolved, and clears the timeout timer.
   *
   * Always safe to call regardless of state.
   */
  dispose(): void {
    this._clearTimer();
    if (!this._resolved) {
      this._resolveInternal();
    }
  }

  /**
   * Internal resolution that sets the flag and calls the stored resolver.
   */
  private _resolveInternal(): void {
    this._resolved = true;
    this._clearTimer();
    if (this._resolve) {
      this._resolve();
      this._resolve = null;
    }
  }

  /**
   * Clears the timeout timer if active.
   */
  private _clearTimer(): void {
    if (this._timer !== undefined) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
  }
}
