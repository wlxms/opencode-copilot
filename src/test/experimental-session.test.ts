import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { createSessionContentProvider } from '../surfaces/vscode/experimental-session';
import type { ExtensionState } from '../types';

describe('createSessionContentProvider', () => {
  let state: ExtensionState;

  beforeEach(() => {
    const sessionsList = vi.fn(async () => ({
      data: [
        { id: 'ses_1', title: 'First Session', createdAt: new Date('2026-05-28T00:00:00Z') },
        { id: 'ses_2', title: '', createdAt: new Date('2026-05-28T01:00:00Z') },
      ],
    }));

    const sessionGet = vi.fn(async () => ({
      data: { id: 'ses_restore', title: '', createdAt: new Date('2026-05-28T03:00:00Z') },
    }));

    const sessionMessages = vi.fn(async (sessionId?: string) => ({
      data: {
        items: sessionId === 'ses_restore'
          ? [
              { id: 'user_1', role: 'user' as const, text: 'Need help with session titles' },
              { id: 'assistant_1', role: 'assistant' as const, text: 'Sure', toolCalls: [] },
            ]
          : [],
      },
    }));

    state = {
      backend: {
        name: 'opencode',
        start: vi.fn(async () => ({ data: { url: 'http://127.0.0.1:4096', status: 'running' as const } })),
        stop: vi.fn(async () => undefined),
        getStatus: vi.fn(() => 'running'),
        getUrl: vi.fn(() => 'http://127.0.0.1:4096'),
        isRunning: vi.fn(() => true),
        sessions: {
          create: vi.fn(),
          get: sessionGet,
          prompt: vi.fn(),
          revert: vi.fn(),
          abort: vi.fn(),
          list: sessionsList,
          children: vi.fn(),
          status: vi.fn(),
          descendants: vi.fn(() => []),
          findAncestor: vi.fn(),
          parent: vi.fn(),
          messages: sessionMessages,
        },
        config: {
          models: vi.fn(async () => ({ data: [] })),
          agents: vi.fn(async () => ({ data: [] })),
          get: vi.fn(),
          update: vi.fn(),
        },
        events: {
          ensureStarted: vi.fn(),
          openSessionStream: vi.fn(),
          closeSessionStream: vi.fn(),
        },
        permissions: {
          reply: vi.fn(),
        },
        questions: {
          reply: vi.fn(),
          reject: vi.fn(),
        },
      },
      outputChannel: vscode.window.createOutputChannel('test'),
      sessionMap: new Map(),
      statusBar: { update: vi.fn() } as unknown as ExtensionState['statusBar'],
      currentAgent: undefined,
      currentModel: undefined,
      currentModelDisplayName: undefined,
    };

    (vscode.workspace as { workspaceFolders?: Array<{ uri: vscode.Uri; name: string; index: number }> }).workspaceFolders = [
      { uri: vscode.Uri.parse('file:///test-workspace'), name: 'test', index: 0 },
    ];
  });

  it('publishes session items from backend sessions.list during refresh', async () => {
    const { controller } = createSessionContentProvider(
      state,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    expect(controller).toBeDefined();

    await controller!.refreshHandler({
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    });

    const items = Array.from(controller!.items).map(([, item]) => item);
    expect(items).toHaveLength(2);
    const labels = items.map(item => item.label);
    const descriptions = items.map(item => item.description);
    const paths = items.map(item => item.resource.path);
    expect(labels).toContain('First Session');
    expect(labels).toContain('Session ses_2');
    expect(descriptions).toEqual([undefined, undefined]);
    expect(paths).toContain('/ses_1');
    expect(paths).toContain('/ses_2');
    expect(items.every(item => item.status === vscode.ChatSessionStatus.Completed)).toBe(true);
  });

  it('publishes runtime session when backend list is empty', async () => {
    state.backend.sessions.list = vi.fn(async () => ({ data: [] }));
    state.sessionMap.set('opencode-copilot.opencode:/untitled-1', {
      opencodeSessionId: 'ses_runtime',
      turnMap: [],
      title: 'Runtime Session',
      createdAt: new Date('2026-05-28T02:00:00Z'),
    });

    const { controller } = createSessionContentProvider(
      state,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    await controller!.refreshHandler({
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    });

    const items = Array.from(controller!.items).map(([, item]) => item);
    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe('Runtime Session');
    expect(items[0]?.description).toBeUndefined();
    expect(items[0]?.resource.path).toBe('/ses_runtime');
  });

  it('preserves restored provider session title in Session list items', async () => {
    state.backend.sessions.list = vi.fn(async () => ({ data: [] }));
    state.sessionMap.set('opencode-copilot.opencode:/ses_restore', {
      opencodeSessionId: 'ses_restore',
      turnMap: [],
      title: 'Restored Session',
      createdAt: new Date('2026-05-28T03:00:00Z'),
    });

    const { controller } = createSessionContentProvider(
      state,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    await controller!.refreshHandler({
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    });

    const items = Array.from(controller!.items).map(([, item]) => item);
    expect(items[0]?.label).toBe('Restored Session');
    expect(items[0]?.description).toBeUndefined();
  });

  it('derives a restored session title from first user message when backend title is empty', async () => {
    state.backend.sessions.list = vi.fn(async () => ({ data: [] }));

    const { provider } = createSessionContentProvider(
      state,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    const session = await provider.provideChatSessionContent(
      vscode.Uri.parse('opencode-copilot.opencode:/ses_restore'),
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
      { inputState: {} as vscode.ChatSessionInputState },
    );
    const restoredResourceKey = vscode.Uri.parse('opencode-copilot.opencode:/ses_restore').toString();

    expect(state.backend.sessions.messages).toHaveBeenCalledWith('ses_restore');
    expect(session.title).toBe('Need help with session titles');
    expect(state.sessionMap.get(restoredResourceKey)?.title).toBe('Need help with session titles');
  });
});
