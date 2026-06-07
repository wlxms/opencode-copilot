import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ExternalEditTracker } from '../participant/external-edit-tracker';

describe('ExternalEditTracker', () => {
  it('pushes an external edit part that waits for completion', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-edit-tracker-'));
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'before\n', 'utf-8');
    const uri = vscode.Uri.file(file);
    const pushed: Array<{ callback?: () => Thenable<unknown>; applied?: Thenable<string> }> = [];

    const stream = {
      push: vi.fn((part: unknown) => pushed.push(part as { callback?: () => Thenable<unknown>; applied?: Thenable<string> })),
    } as unknown as vscode.ChatResponseStream;

    const snapshots: unknown[] = [];
    const tracker = new ExternalEditTracker(snapshot => snapshots.push(snapshot));

    const trackPromise = tracker.trackEdit('edit-1', [uri], stream);
    await trackPromise;

    expect(pushed).toHaveLength(1);
    expect(tracker.hasEdit('edit-1')).toBe(true);
    const completion = tracker.completeEdit('edit-1');
    await completion;

    expect(stream.push).toHaveBeenCalledTimes(1);
    expect(tracker.hasEdit('edit-1')).toBe(false);
    expect(snapshots).toHaveLength(2);
  });
});
