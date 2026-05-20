import * as vscode from 'vscode';

/**
 * Manages per-edit external edit lifecycles for VSCode's checkpoint/undo mechanism.
 *
 * Adapted from Copilot's ExternalEditTracker pattern:
 *
 * Lifecycle per edit:
 *   1. trackEdit(editKey, uris, stream) → pushes ChatResponseExternalEditPart
 *   2. VSCode Pipeline: send(start=true) → captures file baselines from entry model
 *   3. Pipeline calls callback → proceedWithEdit() resolves → caller knows baseline is captured
 *   4. callback blocks on deferred until completeEdit() is called
 *   5. completeEdit(editKey) → deferred resolves → callback returns
 *   6. VSCode Pipeline: send(start=false) → stopExternalEdits
 *   7. part.applied resolves → undoStopId returned
 *
 * Usage with OpenCode permission flow:
 *   - permission.asked arrives → trackEdit(callID, [fileUri], stream)
 *   - trackEdit resolves (baseline captured) → auto-reply "once"
 *   - tool=completed arrives → completeEdit(callID)
 *
 * IMPORTANT — Windows URI Casing:
 *   VSCode's ExternalEditPart performs strict URI path comparison internally.
 *   On Windows, vscode.Uri.file("D:\\path") produces path="/D:/path" (uppercase drive),
 *   but VSCode workspace URIs normalize to "/d:/path" (lowercase drive). This casing
 *   mismatch causes diff capture to silently fail (shows +0-0 instead of actual diff).
 *   Callers MUST normalize the URI before passing it to trackEdit(), e.g.:
 *     const rawUri = vscode.Uri.file(filepath);
 *     const norm = rawUri.path.replace(/^\/([A-Z]):\//, (_, d) => `/${d.toLowerCase()}:`);
 *     const fileUri = norm !== rawUri.path ? rawUri.with({ path: norm }) : rawUri;
 */
export class ExternalEditTracker {
  private _ongoingEdits = new Map<
    string,
    {
      complete: () => void;
      onDidComplete: Thenable<string>;
      uris: readonly vscode.Uri[];
    }
  >();

  hasEdit(editKey: string): boolean {
    return this._ongoingEdits.has(editKey);
  }

  /**
   * Check if any of the given URIs are already being tracked by an active edit.
   * Used to prevent pushing duplicate ExternalEditParts for the same file.
   */
  isTrackingAny(uris: readonly vscode.Uri[]): boolean {
    const uriSet = new Set(uris.map(u => u.toString()));
    for (const edit of this._ongoingEdits.values()) {
      for (const u of edit.uris) {
        if (uriSet.has(u.toString())) {
          return true;
        }
      }
    }
    return false;
  }

  async trackEdit(
    editKey: string,
    uris: vscode.Uri[],
    stream: vscode.ChatResponseStream,
    token?: vscode.CancellationToken,
  ): Promise<void> {
    if (!uris.length || token?.isCancellationRequested) {
      return;
    }

    const ExternalEditCtor = (vscode as any).ChatResponseExternalEditPart as
      | (new (
          uris: readonly vscode.Uri[],
          callback: () => Thenable<unknown>,
        ) => { applied: Thenable<string> })
      | undefined;

    if (!ExternalEditCtor) {
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

      const part = new ExternalEditCtor(uris, async () => {
        resolveTrackEdit();
        await deferredPromise;
        cancelDisposable?.dispose();
      });

      (stream as any).push(part);

      this._ongoingEdits.set(editKey, {
        onDidComplete: part.applied,
        complete: () => deferredResolve?.(),
        uris,
      });
    });
  }

  completeEdit(editKey: string): Thenable<string> | undefined {
    const edit = this._ongoingEdits.get(editKey);
    if (!edit) {
      return undefined;
    }
    this._ongoingEdits.delete(editKey);
    edit.complete();
    return edit.onDidComplete;
  }

  dispose(): void {
    for (const edit of this._ongoingEdits.values()) {
      edit.complete();
    }
    this._ongoingEdits.clear();
  }
}
