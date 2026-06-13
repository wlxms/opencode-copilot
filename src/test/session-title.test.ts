import { describe, expect, it, vi } from 'vitest';
import { applySessionTitle } from '../participant/session-title';
import type { ExtensionState } from '../types';

describe('applySessionTitle', () => {
  it('merges title updates so request details are preserved in session metadata', async () => {
    const updateMeta = vi.fn().mockResolvedValue(undefined);
    const state = {
      backend: { name: 'opencode', sessions: { update: vi.fn() } },
      outputChannel: { appendLine: vi.fn() },
      sessions: {
        get: vi.fn(),
        values: vi.fn(() => []),
      },
      sessionStore: {
        updateMeta,
      },
      bus: { emit: vi.fn() },
    } as unknown as ExtensionState;

    await applySessionTitle(state, {
      backendSessionId: 'ses-title-preserve',
      title: 'Real Title',
      source: 'backend',
    });

    expect(updateMeta).toHaveBeenCalledWith(
      'ses-title-preserve',
      expect.objectContaining({
        title: 'Real Title',
        titleSource: 'backend',
        backendName: 'opencode',
      }),
    );
    expect(updateMeta.mock.calls[0]?.[1]).not.toHaveProperty('requestDetails');
  });
});
