import { describe, it, expect, beforeEach } from 'vitest';
import { CheckpointManager, collectOpenFileUris, CheckpointSignal } from '../participant/checkpoint';
import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// CheckpointManager unit tests
// ---------------------------------------------------------------------------

describe('CheckpointManager', () => {
  let manager: CheckpointManager;

  beforeEach(() => {
    manager = new CheckpointManager();
  });

  // -------------------------------------------------------------------------
  // createIdlePromise
  // -------------------------------------------------------------------------

  it('createIdlePromise creates a promise and sets hasActiveCheckpoint true', () => {
    expect(manager.hasActiveCheckpoint()).toBe(false);

    manager.createIdlePromise();

    expect(manager.hasActiveCheckpoint()).toBe(true);

    // The promise should NOT resolve immediately — it's pending.
    let resolved = false;
    manager.waitForIdle().then(() => { resolved = true; });
    expect(resolved).toBe(false);
  });

  // -------------------------------------------------------------------------
  // resolveIdle
  // -------------------------------------------------------------------------

  it('resolveIdle resolves the promise and clears active checkpoint', async () => {
    manager.createIdlePromise();
    expect(manager.hasActiveCheckpoint()).toBe(true);

    manager.resolveIdle();

    await manager.waitForIdle();
    expect(manager.hasActiveCheckpoint()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Idempotent createIdlePromise
  // -------------------------------------------------------------------------

  it('createIdlePromise is idempotent — second call is a no-op', async () => {
    manager.createIdlePromise();
    manager.createIdlePromise(); // second call should not overwrite

    // Only one resolve should settle it
    manager.resolveIdle();
    await manager.waitForIdle();
    expect(manager.hasActiveCheckpoint()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // waitForIdle with no checkpoint
  // -------------------------------------------------------------------------

  it('waitForIdle returns resolved promise when no checkpoint exists', async () => {
    // Should settle immediately — no active checkpoint
    await expect(manager.waitForIdle()).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // dispose
  // -------------------------------------------------------------------------

  it('dispose resolves pending promise', async () => {
    manager.createIdlePromise();
    expect(manager.hasActiveCheckpoint()).toBe(true);

    manager.dispose();

    expect(manager.hasActiveCheckpoint()).toBe(false);
    await manager.waitForIdle();
  });

  // -------------------------------------------------------------------------
  // resolveIdle idempotent
  // -------------------------------------------------------------------------

  it('resolveIdle is idempotent — second call does not throw', () => {
    manager.createIdlePromise();
    manager.resolveIdle();
    expect(() => manager.resolveIdle()).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // setFileUris / getFileUris
  // -------------------------------------------------------------------------

  it('setFileUris stores URIs and getFileUris returns them', () => {
    const uris = [vscode.Uri.file('/a.ts'), vscode.Uri.file('/b.ts')];

    manager.setFileUris(uris);

    expect(manager.getFileUris()).toEqual(uris);
  });

  // -------------------------------------------------------------------------
  // addAdditionalUri / getAdditionalUris
  // -------------------------------------------------------------------------

  it('addAdditionalUri stores URIs and getAdditionalUris returns them', () => {
    const uri1 = vscode.Uri.file('/x.ts');
    const uri2 = vscode.Uri.file('/y.ts');

    manager.addAdditionalUri(uri1);
    manager.addAdditionalUri(uri2);

    const result = manager.getAdditionalUris();
    expect(result.has(uri1.toString())).toBe(true);
    expect(result.has(uri2.toString())).toBe(true);
    expect(result.size).toBe(2);
  });

  it('addAdditionalUri ignores duplicate URIs (Set behavior)', () => {
    const uri = vscode.Uri.file('/dup.ts');

    manager.addAdditionalUri(uri);
    manager.addAdditionalUri(uri); // duplicate

    expect(manager.getAdditionalUris().size).toBe(1);
  });

  // -------------------------------------------------------------------------
  // dispose with no checkpoint
  // -------------------------------------------------------------------------

  it('dispose when no checkpoint exists is safe', () => {
    expect(() => manager.dispose()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// collectOpenFileUris unit tests
// ---------------------------------------------------------------------------

describe('collectOpenFileUris', () => {
  it('returns only file-scheme, non-untitled documents', () => {
    const docs = [
      { uri: vscode.Uri.file('/real.ts'), isUntitled: false },
      { uri: vscode.Uri.parse('untitled:/scratch.ts'), isUntitled: true },
      { uri: vscode.Uri.file('/other.ts'), isUntitled: false },
    ];

    // Replace vscode.workspace.textDocuments with our mock
    const original = (vscode.workspace as { textDocuments: unknown }).textDocuments;
    (vscode.workspace as { textDocuments: unknown }).textDocuments = docs;

    const result = collectOpenFileUris();

    expect(result).toHaveLength(2);
    expect(result[0].fsPath).toBe('/real.ts'.replace(/\//g, '\\'));
    expect(result[1].fsPath).toBe('/other.ts'.replace(/\//g, '\\'));

    // Restore
    (vscode.workspace as { textDocuments: unknown }).textDocuments = original;
  });

  it('returns empty array when no documents are open', () => {
    const original = (vscode.workspace as { textDocuments: unknown }).textDocuments;
    (vscode.workspace as { textDocuments: unknown }).textDocuments = [];

    const result = collectOpenFileUris();
    expect(result).toEqual([]);

    (vscode.workspace as { textDocuments: unknown }).textDocuments = original;
  });
});

// ---------------------------------------------------------------------------
// CheckpointSignal unit tests
// ---------------------------------------------------------------------------

describe('CheckpointSignal', () => {
  // -------------------------------------------------------------------------
  // notify without waiter is silently dropped
  // -------------------------------------------------------------------------

  it('notify() without a waiter is silently dropped (no count accumulation)', async () => {
    const signal = new CheckpointSignal();

    // These notifies fire before any wait() is registered — they are no-ops
    signal.notify();
    signal.notify();
    signal.notify();

    // wait() should NOT return immediately — no buffered signals
    let resolved = false;
    const waitPromise = signal.wait().then(() => { resolved = true; });
    expect(resolved).toBe(false);

    // Only a new notify() should resolve the wait
    signal.notify();
    await waitPromise;
    expect(resolved).toBe(true);
  });

  // -------------------------------------------------------------------------
  // wait before notify blocks until notify
  // -------------------------------------------------------------------------

  it('wait() before notify() blocks until notify()', async () => {
    const signal = new CheckpointSignal();
    let resolved = false;

    const waitPromise = signal.wait().then(() => { resolved = true; });

    // Should not be resolved yet
    expect(resolved).toBe(false);

    signal.notify();

    await waitPromise;
    expect(resolved).toBe(true);
  });

  // -------------------------------------------------------------------------
  // dispose resolves current waiter
  // -------------------------------------------------------------------------

  it('dispose() resolves current waiter', async () => {
    const signal = new CheckpointSignal();
    let resolved1 = false;

    const p1 = signal.wait().then(() => { resolved1 = true; });

    // Not resolved yet
    expect(resolved1).toBe(false);

    signal.dispose();

    await p1;
    expect(resolved1).toBe(true);
  });

  // -------------------------------------------------------------------------
  // dispose prevents future wait from blocking
  // -------------------------------------------------------------------------

  it('dispose() prevents future wait() from blocking', async () => {
    const signal = new CheckpointSignal();

    signal.dispose();

    // After dispose, wait() should return immediately without notifying
    await expect(signal.wait()).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // sequential wait/notify cycles work correctly
  // -------------------------------------------------------------------------

  it('sequential wait/notify cycles work correctly', async () => {
    const signal = new CheckpointSignal();

    // Cycle 1: wait → notify
    const p1 = signal.wait();
    signal.notify();
    await expect(p1).resolves.toBeUndefined();

    // Cycle 2: wait → notify
    const p2 = signal.wait();
    signal.notify();
    await expect(p2).resolves.toBeUndefined();

    // Cycle 3: wait → dispose (end of turn)
    const p3 = signal.wait();
    signal.dispose();
    await expect(p3).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // notify after dispose is a no-op
  // -------------------------------------------------------------------------

  it('notify() after dispose() is a no-op', () => {
    const signal = new CheckpointSignal();
    signal.dispose();

    // Should not throw — notify is guarded by disposed check
    expect(() => signal.notify()).not.toThrow();
  });
});
