import * as vscode from 'vscode';

/**
 * Manages per-edit external edit lifecycles for VSCode's checkpoint/undo mechanism.
 *
 * Adapted from Copilot's ExternalEditTracker pattern:
 *
 * Lifecycle per edit:
 *   1. trackEdit(editKey, uris, stream) → calls stream.externalEdit()
 *   2. VSCode: send(start=true) → captures file baselines
 *   3. callback runs: proceedWithEdit() resolves → caller knows baseline is captured
 *   4. callback blocks on deferred until completeEdit() is called
 *   5. completeEdit(editKey) → deferred resolves → callback returns
 *   6. VSCode: send(start=false) → enables undo checkpoint
 *
 * Usage with OpenCode permission flow:
 *   - permission.asked arrives → trackEdit(callID, [fileUri], stream)
 *   - trackEdit resolves (baseline captured) → auto-reply "once"
 *   - tool=completed arrives → completeEdit(callID)
 */
export class ExternalEditTracker {
  private _ongoingEdits = new Map<
    string,
    {
      complete: () => void;
      onDidComplete: Thenable<string>;
    }
  >();

  /**
   * Returns true if there is an active edit being tracked for the given key.
   */
  hasEdit(editKey: string): boolean {
    return this._ongoingEdits.has(editKey);
  }

  /**
   * Start tracking an external edit for the given URIs.
   *
   * Resolves when VSCode has captured the file baselines (send(start=true) complete).
   * The caller can then safely proceed with the edit (e.g., reply "once" to permission).
   *
   * After the edit completes, call completeEdit(editKey) to finalize the checkpoint.
   *
   * @param editKey Unique identifier (typically tool callID from permission.asked)
   * @param uris File URIs to track
   * @param stream VSCode ChatResponseStream (must support proposed externalEdit API)
   * @param token Optional cancellation token
   */
  async trackEdit(
    editKey: string,
    uris: vscode.Uri[],
    stream: vscode.ChatResponseStream,
    token?: vscode.CancellationToken,
  ): Promise<void> {
    if (!uris.length || token?.isCancellationRequested) {
      return;
    }

    // Check if stream.externalEdit is available (proposed API)
    const externalEditFn = (stream as any).externalEdit as
      | ((target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => Thenable<string>)
      | undefined;

    if (!externalEditFn || typeof externalEditFn !== 'function') {
      // Proposed API not available — skip external edit tracking
      return;
    }

    return new Promise<void>((resolveTrackEdit) => {
      let deferredResolve: (() => void) | null = null;
      const deferredPromise = new Promise<void>((r) => {
        deferredResolve = r;
      });

      let cancelDisposable: vscode.Disposable | undefined;
      if (token) {
        cancelDisposable = token.onCancellationRequested(() => {
          this._ongoingEdits.delete(editKey);
          deferredResolve?.();
        });
      }

      const onDidComplete = externalEditFn.call(
        stream,
        uris,
        async () => {
          // send(start=true) has completed — baseline captured
          resolveTrackEdit();

          // Block until completeEdit() is called
          await deferredPromise;
          cancelDisposable?.dispose();
        },
      );

      this._ongoingEdits.set(editKey, {
        onDidComplete,
        complete: () => deferredResolve?.(),
      });
    });
  }

  /**
   * Complete an ongoing external edit.
   *
   * Resolves the deferred promise inside the callback, allowing
   * send(start=false) to execute and the undo checkpoint to be created.
   *
   * @param editKey The same key passed to trackEdit
   * @returns The applied Thenable from stream.externalEdit, or undefined if not tracked
   */
  completeEdit(editKey: string): Thenable<string> | undefined {
    const edit = this._ongoingEdits.get(editKey);
    if (!edit) {
      return undefined;
    }
    this._ongoingEdits.delete(editKey);
    edit.complete();
    return edit.onDidComplete;
  }

  /**
   * Clean up all ongoing edits (e.g., on cancellation or error).
   */
  dispose(): void {
    for (const edit of this._ongoingEdits.values()) {
      edit.complete();
    }
    this._ongoingEdits.clear();
  }
}
