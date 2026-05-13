import * as vscode from 'vscode';

/**
 * Manages per-turn idle checkpoint lifecycle.
 *
 * Instantiated once per chat request. Tracks an idle promise that signals
 * when the turn has finished processing, and accumulates file URIs that
 * were open or touched during the turn.
 */
export class CheckpointManager {
  private idleResolve: (() => void) | null = null;
  private idlePromise: Promise<void> | null = null;
  private fileUris: readonly vscode.Uri[] = [];
  private additionalUris: Set<string> = new Set();

  /**
   * Creates a new idle promise if one does not already exist.
   * Call at the start of a turn to arm the checkpoint.
   */
  createIdlePromise(): void {
    if (this.idlePromise) return; // already created
    this.idlePromise = new Promise<void>((resolve) => {
      this.idleResolve = resolve;
    });
  }

  /**
   * Resolves the stored idle promise, signalling turn completion.
   * No-ops if no active checkpoint exists.
   */
  resolveIdle(): void {
    if (this.idleResolve) {
      this.idleResolve();
      this.idleResolve = null;
    }
  }

  /**
   * Returns the current idle promise for awaiting.
   * Resolves immediately if no active checkpoint exists.
   */
  waitForIdle(): Promise<void> {
    if (!this.idlePromise) {
      return Promise.resolve(); // no active checkpoint
    }
    return this.idlePromise;
  }

  /**
   * Returns `true` if there is an unresolved idle promise.
   */
  hasActiveCheckpoint(): boolean {
    return this.idlePromise !== null && this.idleResolve !== null;
  }

  /**
   * Returns the proactive file URIs captured at checkpoint start.
   */
  getFileUris(): readonly vscode.Uri[] {
    return this.fileUris;
  }

  /**
   * Sets the proactive file URIs (typically open editors at turn start).
   */
  setFileUris(uris: readonly vscode.Uri[]): void {
    this.fileUris = uris;
  }

  /**
   * Returns additional file URIs discovered during tool events.
   */
  getAdditionalUris(): Set<string> {
    return this.additionalUris;
  }

  /**
   * Adds a file URI discovered during tool events.
   */
  addAdditionalUri(uri: vscode.Uri): void {
    this.additionalUris.add(uri.toString());
  }

  /**
   * Cleans up by resolving any pending idle promise.
   */
  dispose(): void {
    this.resolveIdle();
  }
}

/**
 * Collects URIs from all open text documents that represent real files.
 * Filters out untitled documents and non-file schemes.
 */
export function collectOpenFileUris(): vscode.Uri[] {
  return vscode.workspace.textDocuments
    .filter((doc) => doc.uri.scheme === 'file' && !doc.isUntitled)
    .map((doc) => doc.uri);
}
