import * as vscode from 'vscode';
import { Gate } from './gate';

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
  private activeGates: Set<Gate> = new Set();

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
   * Creates a new Gate and tracks it for automatic cleanup on dispose.
   *
   * @param timeoutMs - Optional timeout in milliseconds before the gate auto-resolves.
   *                    Defaults to Gate's internal default (30000ms).
   */
  createGate(timeoutMs?: number): Gate {
    const gate = new Gate(timeoutMs);
    this.activeGates.add(gate);
    return gate;
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
   * Cleans up by resolving all tracked gates and any pending idle promise.
   */
  dispose(): void {
    for (const gate of this.activeGates) {
      gate.resolve();
    }
    this.activeGates.clear();
    this.resolveIdle();
  }
}

/**
 * Unidirectional checkpoint signal: SSE loop produces, ExternalEditPart callback consumes.
 * Unlike Gate, the producer never blocks — it only resolves pending consumers.
 *
 * Uses a per-cycle resolver pattern instead of a count-based approach.
 * Each `wait()` call registers a fresh resolver; `notify()` resolves the
 * current resolver if one exists. If no resolver is registered (no one
 * waiting), the signal is silently dropped — no count accumulation.
 *
 * This eliminates the "count leak" bug where surplus notify() calls would
 * cause subsequent wait() calls to return immediately, making ExternalEditPart
 * callbacks exit before VSCode could snapshot pre-edit file state.
 */
export class CheckpointSignal {
  private currentResolve: (() => void) | null = null;
  private disposed = false;

  /** Producer (SSE loop): emit one checkpoint signal. Non-blocking. */
  notify(): void {
    if (this.disposed) return;
    if (this.currentResolve) {
      const resolve = this.currentResolve;
      this.currentResolve = null;
      resolve();
    }
    // If no currentResolve, the signal is dropped — the consumer hasn't
    // registered a wait() yet, so there's nothing to wake up. The next
    // wait() will create a fresh promise that waits for the NEXT notify().
  }

  /** Consumer (callback): wait for next checkpoint signal. */
  async wait(): Promise<void> {
    if (this.disposed) return;
    await new Promise<void>((resolve) => {
      this.currentResolve = resolve;
    });
  }

  /** End-of-turn: resolve current waiter (if any). */
  dispose(): void {
    this.disposed = true;
    if (this.currentResolve) {
      this.currentResolve();
      this.currentResolve = null;
    }
  }
}

/**
 * Collects URIs from all open text documents that represent real files.
 * Filters out untitled documents and non-file schemes.
 * @param workspaceRoot - Optional workspace root path to scope the collection to.
 */
export function collectOpenFileUris(workspaceRoot?: string): vscode.Uri[] {
  return vscode.workspace.textDocuments
    .filter((doc) => {
      if (doc.uri.scheme !== 'file' || doc.isUntitled) return false;
      if (workspaceRoot) {
        // Normalize paths for comparison (case-insensitive on Windows)
        const docPath = doc.uri.fsPath.toLowerCase();
        const rootPath = workspaceRoot.toLowerCase();
        return docPath.startsWith(rootPath);
      }
      return true;
    })
    .map((doc) => doc.uri);
}
