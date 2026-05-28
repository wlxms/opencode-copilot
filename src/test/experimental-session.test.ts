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
          update: vi.fn(async () => ({ data: { id: 'updated-session', title: 'Updated Title', createdAt: new Date() } })),
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

  // =========================================================================
  // Title persistence tests — verify fix for titles reverting to placeholder
  // after tab switches (backend stores placeholder at create time).
  // =========================================================================

  it('derives title from history when backend returns placeholder title "New OpenCode Session"', async () => {
    state.backend.sessions.get = vi.fn(async () => ({
      data: { id: 'ses_placeholder', title: 'New OpenCode Session', createdAt: new Date('2026-05-28T03:00:00Z') },
    }));
    state.backend.sessions.messages = vi.fn(async () => ({
      data: {
        items: [
          { id: 'user_1', role: 'user' as const, text: 'How do I fix the auth bug?' },
          { id: 'assistant_1', role: 'assistant' as const, text: 'Let me check', toolCalls: [] },
        ],
      },
    }));

    const { provider } = createSessionContentProvider(
      state,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    const session = await provider.provideChatSessionContent(
      vscode.Uri.parse('opencode-copilot.opencode:/ses_placeholder'),
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
      { inputState: {} as vscode.ChatSessionInputState },
    );

    expect(session.title).toBe('How do I fix the auth bug?');
  });

  it('derives title from history when backend returns placeholder "OpenCode Session xxx"', async () => {
    state.backend.sessions.get = vi.fn(async () => ({
      data: { id: 'ses_abc12345', title: 'OpenCode Session abc12345', createdAt: new Date('2026-05-28T03:00:00Z') },
    }));
    state.backend.sessions.messages = vi.fn(async () => ({
      data: {
        items: [
          { id: 'user_1', role: 'user' as const, text: 'Refactor the database layer' },
          { id: 'assistant_1', role: 'assistant' as const, text: 'Sure', toolCalls: [] },
        ],
      },
    }));

    const { provider } = createSessionContentProvider(
      state,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    const session = await provider.provideChatSessionContent(
      vscode.Uri.parse('opencode-copilot.opencode:/ses_abc12345'),
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
      { inputState: {} as vscode.ChatSessionInputState },
    );

    expect(session.title).toBe('Refactor the database layer');
  });

  it('prefers runtime non-placeholder title over placeholder when same opencodeSessionId has multiple entries', async () => {
    state.backend.sessions.list = vi.fn(async () => ({ data: [] }));

    // Original tab entry with derived title
    state.sessionMap.set('opencode-copilot.opencode:/untitled-1', {
      opencodeSessionId: 'ses_dup',
      turnMap: [],
      title: 'Derived From Prompt',
      createdAt: new Date('2026-05-28T01:00:00Z'),
    });

    // Session list click created a duplicate entry with placeholder title
    state.sessionMap.set('opencode-copilot.opencode:/ses_dup', {
      opencodeSessionId: 'ses_dup',
      turnMap: [],
      title: 'New OpenCode Session',
      createdAt: new Date('2026-05-28T01:00:00Z'),
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
    expect(items[0]?.label).toBe('Derived From Prompt');
  });

  it('restoring existing session reuses non-placeholder title from another sessionMap entry', async () => {
    // Pre-populate sessionMap with the original entry that has the derived title
    state.sessionMap.set('opencode-copilot.opencode:/untitled-1', {
      opencodeSessionId: 'ses_existing',
      turnMap: [],
      title: 'My original prompt title',
      createdAt: new Date('2026-05-28T01:00:00Z'),
    });

    // Backend still has the placeholder title (never updated in backend)
    state.backend.sessions.get = vi.fn(async () => ({
      data: { id: 'ses_existing', title: 'New OpenCode Session', createdAt: new Date('2026-05-28T01:00:00Z') },
    }));
    state.backend.sessions.messages = vi.fn(async () => ({
      data: { items: [] },
    }));

    const { provider } = createSessionContentProvider(
      state,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );

    const session = await provider.provideChatSessionContent(
      vscode.Uri.parse('opencode-copilot.opencode:/ses_existing'),
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
      { inputState: {} as vscode.ChatSessionInputState },
    );

    const newKey = vscode.Uri.parse('opencode-copilot.opencode:/ses_existing').toString();
    expect(state.sessionMap.get(newKey)?.title).toBe('My original prompt title');
    expect(session.title).toBe('My original prompt title');
  });
});
