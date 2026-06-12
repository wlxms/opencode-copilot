import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ExternalEditTracker } from '../participant/external-edit-tracker';

describe('ExternalEditTracker', () => {
  it('uses stream.externalEdit when available and waits for completion', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-edit-tracker-'));
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'before\n', 'utf-8');
    const uri = vscode.Uri.file(file);
    let externalEditCallback: (() => Thenable<unknown>) | undefined;

    const stream = {
      externalEdit: vi.fn((_target: vscode.Uri | vscode.Uri[], callback: () => Thenable<unknown>) => {
        externalEditCallback = callback;
        return Promise.resolve(callback()).then(() => 'undo-stop-stream');
      }),
      push: vi.fn(),
    } as unknown as vscode.ChatResponseStream;

    const snapshots: unknown[] = [];
    const tracker = new ExternalEditTracker(snapshot => snapshots.push(snapshot));

    const trackPromise = tracker.trackEdit('edit-1', [uri], stream);
    await trackPromise;

    expect(stream.externalEdit).toHaveBeenCalledWith([uri], expect.any(Function));
    expect(externalEditCallback).toBeTypeOf('function');
    expect(tracker.hasEdit('edit-1')).toBe(true);
    const completion = tracker.completeEdit('edit-1');
    await expect(completion).resolves.toBe('undo-stop-stream');

    expect(stream.push).not.toHaveBeenCalled();
    expect(tracker.hasEdit('edit-1')).toBe(false);
    expect(snapshots).toHaveLength(2);
  });

  it('falls back to ChatResponseExternalEditPart push when stream.externalEdit is unavailable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-edit-tracker-undo-'));
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'before\n', 'utf-8');
    const uri = vscode.Uri.file(file);
    const pushed: Array<{ callback?: () => Thenable<unknown>; applied?: Thenable<string> }> = [];

    (vscode.ChatResponseExternalEditPart as unknown as { nextUndoStopId: string }).nextUndoStopId = 'undo-stop-1';
    const stream = {
      push: vi.fn((part: unknown) => pushed.push(part as { callback?: () => Thenable<unknown>; applied?: Thenable<string> })),
    } as unknown as vscode.ChatResponseStream;

    const snapshots: Array<{ phase?: string; undoStopId?: string }> = [];
    const tracker = new ExternalEditTracker(snapshot => snapshots.push(snapshot));

    try {
      await tracker.trackEdit('edit-1', [uri], stream);
      fs.writeFileSync(file, 'after\n', 'utf-8');
      await tracker.completeEdit('edit-1');

      expect(stream.push).toHaveBeenCalledTimes(1);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0]).toMatchObject({ phase: 'before' });
      expect(snapshots[0]?.undoStopId).toBeUndefined();
      expect(snapshots[1]).toMatchObject({ phase: 'after', undoStopId: 'undo-stop-1' });
    } finally {
      (vscode.ChatResponseExternalEditPart as unknown as { nextUndoStopId: string }).nextUndoStopId = '';
    }
  });
});
