import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'node:fs';
import type { FileSnapshotRecord } from '../acp/serializable/types';

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
 *   On Windows, URI casing mismatches can cause VSCode's strict internal URI
 *   comparison to miss the edited file (shows +0-0 instead of actual diff).
 *   Callers MUST normalize the file URI path before passing it to trackEdit(), e.g.:
 *     const rawUri = vscode.Uri.file(filepath);
 *     const norm = /^\/[a-zA-Z]:(?=\/)/.test(rawUri.path) ? rawUri.path.toLowerCase() : rawUri.path;
 *     const fileUri = norm !== rawUri.path ? rawUri.with({ path: norm }) : rawUri;
 */
export class ExternalEditTracker {
  private _ongoingEdits = new Map<
    string,
    {
      complete: () => void;
      onDidComplete: Thenable<string>;
      uris: readonly vscode.Uri[];
      beforeSnapshots: FileSnapshotRecord[];
    }
  >();

  constructor(
    private readonly onSnapshot?: (snapshot: FileSnapshotRecord) => void,
    private readonly getTurnIndex?: () => number,
  ) {}

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
    const beforeSnapshots = uris.map((uri, index) => captureSnapshot(uri, editKey, 'before', index, this.getTurnIndex?.()));

    const externalEdit = (stream as {
      externalEdit?: (target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => Thenable<string>;
    }).externalEdit;
    const ExternalEditCtor = (vscode as any).ChatResponseExternalEditPart as
      | (new (
          uris: readonly vscode.Uri[],
          callback: () => Thenable<unknown>,
        ) => { applied: Thenable<string> })
      | undefined;
    const push = (stream as { push?: (part: unknown) => void }).push;

    if (typeof externalEdit !== 'function' && (!ExternalEditCtor || typeof push !== 'function')) {
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

      const callback = async () => {
        for (const snapshot of beforeSnapshots) {
          this.onSnapshot?.(snapshot);
        }
        resolveTrackEdit();
        await deferredPromise;
        cancelDisposable?.dispose();
      };

      const onDidComplete = typeof externalEdit === 'function'
        ? externalEdit.call(stream, uris, callback)
        : (() => {
            const part = new ExternalEditCtor!(uris, callback);
            push!.call(stream, part);
            return part.applied;
          })();

      this._ongoingEdits.set(editKey, {
        onDidComplete,
        complete: () => deferredResolve?.(),
        uris,
        beforeSnapshots,
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
    const completed = Promise.resolve(edit.onDidComplete);
    completed.then(
      (undoStopId) => {
        edit.uris.forEach((uri, index) => {
          this.onSnapshot?.({
            ...captureSnapshot(uri, editKey, 'after', edit.beforeSnapshots.length + index, this.getTurnIndex?.()),
            undoStopId: undoStopId || undefined,
          });
        });
      },
      () => {
        edit.uris.forEach((uri, index) => {
          this.onSnapshot?.(captureSnapshot(uri, editKey, 'after', edit.beforeSnapshots.length + index, this.getTurnIndex?.()));
        });
      },
    );
    return completed;
  }

  dispose(): void {
    for (const edit of this._ongoingEdits.values()) {
      edit.complete();
    }
    this._ongoingEdits.clear();
  }
}

function captureSnapshot(
  uri: vscode.Uri,
  toolCallId: string,
  phase: 'before' | 'after',
  editIndex: number,
  turnIndex?: number,
): FileSnapshotRecord {
  const missing = !existsSync(uri.fsPath);
  return {
    uri: uri.toString(),
    content: missing ? '' : readFileSync(uri.fsPath, 'utf-8'),
    phase,
    turnIndex,
    editIndex,
    toolCallId,
    timestamp: new Date().toISOString(),
    missing,
  };
}
