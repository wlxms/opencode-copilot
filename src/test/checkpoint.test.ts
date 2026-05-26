import { describe, it, expect, beforeEach } from 'vitest';
import { CheckpointManager, collectOpenFileUris } from '../participant/checkpoint';
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
    expect(() => { manager.resolveIdle(); }).not.toThrow();
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
    expect(() => { manager.dispose(); }).not.toThrow();
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
