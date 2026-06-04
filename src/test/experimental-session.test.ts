import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { createSessionContentProvider } from '../surfaces/vscode/experimental-session';
import { isUserSelectableAgent } from '../acp/types';
import type { AcpAgent } from '../acp/types';
import type { AcpBackend } from '../acp/backend';
import type { ExtensionState } from '../types';
import { AppEventBus } from '../acp/app-event-bus';
import { readSessionEvents } from '../acp/serializable/serializer';
import { readCheckpoints } from '../acp/checkpoint/checkpoint-store';

vi.mock('../acp/serializable/serializer', () => ({
  readSessionEvents: vi.fn(),
}));
vi.mock('../acp/checkpoint/checkpoint-store', () => ({
  readCheckpoints: vi.fn(),
}));

function makeTextEvent(text: string) {
  return {
    type: 'part.updated',
    part: { id: `p_${Date.now()}`, type: 'text', text },
  };
}

describe('createSessionContentProvider', () => {
  let state: ExtensionState;

  beforeEach(() => {
    const sessionStore = new Map<string, unknown>();
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

    vi.mocked(readSessionEvents).mockResolvedValue([]);
    vi.mocked(readCheckpoints).mockResolvedValue([]);

    state = {
      backend: {
        name: 'opencode',
        start: vi.fn(async () => ({ data: { url: 'http://127.0.0.1:4096', status: 'running' as const } })),
        stop: vi.fn(async () => undefined),
        getStatus: vi.fn((): import('../acp/types').AcpServerStatus => 'running'),
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
          updateGlobal: vi.fn(async () => ({ data: undefined })),
        },
        auth: {
          setKey: vi.fn(async () => ({ data: undefined })),
          removeKey: vi.fn(async () => ({ data: undefined })),
        },
        events: {
          ensureStarted: vi.fn(),
          openSessionStream: vi.fn(),
          openGlobalStream: vi.fn(),
          closeSessionStream: vi.fn(),
        },
        permissions: {
          reply: vi.fn(),
        },
        questions: {
          reply: vi.fn(),
          reject: vi.fn(),
        },
        createBridge: vi.fn(() => ({
          setStream: vi.fn(),
          setCallbacks: vi.fn(),
          setTracker: vi.fn(),
          processEvent: vi.fn(),
          run: vi.fn().mockResolvedValue(true),
          getUserMessageId: vi.fn().mockReturnValue(null),
          getSessionTitle: vi.fn().mockReturnValue(null),
          getHadSubagentTasks: vi.fn().mockReturnValue(false),
        })) as unknown as AcpBackend['createBridge'],
      },
      outputChannel: vscode.window.createOutputChannel('test'),
      sessions: {
        get: vi.fn((key: string) => sessionStore.get(key)),
        has: vi.fn((key: string) => sessionStore.has(key)),
        set: vi.fn((key: string, value: unknown) => { sessionStore.set(key, value); }),
        values: vi.fn(() => sessionStore.values()),
      } as unknown as ExtensionState['sessions'],
      statusBar: { update: vi.fn() } as unknown as ExtensionState['statusBar'],
      selection: {
        get: vi.fn(() => ({ agent: undefined, model: undefined, modelDisplayName: undefined })),
        setAgent: vi.fn(async () => {}),
        setModel: vi.fn(async () => {}),
      } as unknown as ExtensionState['selection'],
      bus: new AppEventBus(),
      acpModels: {
        sync: vi.fn(async () => {}),
        resolve: vi.fn(() => ({ kind: 'not-found' as const })),
        getModelsForCopilotRegistration: vi.fn(() => []),
        refresh: vi.fn(async () => {}),
        dispose: vi.fn(),
      } as unknown as ExtensionState['acpModels'],
      sessionStore: {
        listSessions: vi.fn().mockResolvedValue([]),
        getTurnsPath: vi.fn().mockReturnValue(''),
        getSessionDir: vi.fn().mockReturnValue(''),
        initialize: vi.fn().mockResolvedValue(undefined),
      } as any,
    };

    (vscode.workspace as { workspaceFolders?: Array<{ uri: vscode.Uri; name: string; index: number }> }).workspaceFolders = [
      { uri: vscode.Uri.parse('file:///test-workspace'), name: 'test', index: 0 },
    ];
  });

  it('publishes session items from SessionStore during refresh', async () => {
    // Mock SessionStore to return expected sessions
    (state.sessionStore.listSessions as any).mockResolvedValue([
      { id: 'ses_1', title: 'First Session', createdAt: '2026-05-28T01:00:00Z', backendName: 'opencode' },
      { id: 'ses_2', title: 'Session ses_2', createdAt: '2026-05-28T01:30:00Z', backendName: 'opencode' },
    ]);

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
    const paths = items.map(item => item.resource.path);
    expect(labels).toContain('First Session');
    expect(labels).toContain('Session ses_2');
    expect(paths).toContain('/ses_1');
    expect(paths).toContain('/ses_2');
    expect(items.every(item => item.status === vscode.ChatSessionStatus.Completed)).toBe(true);
  });

  it('publishes runtime session when backend list is empty', async () => {
    (state.sessionStore.listSessions as any).mockResolvedValue([
      { id: 'ses_runtime', title: 'Runtime Session', createdAt: '2026-05-28T02:00:00.000Z', backendName: 'opencode' },
    ]);

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
    (state.sessionStore.listSessions as any).mockResolvedValue([
      { id: 'ses_restore', title: 'Restored Session', createdAt: '2026-05-28T03:00:00.000Z', backendName: 'opencode' },
    ]);

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
    vi.mocked(readSessionEvents).mockResolvedValue([
      makeTextEvent('Need help with session titles') as any,
    ]);

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

    expect(state.sessionStore.getTurnsPath).toHaveBeenCalledWith('ses_restore');
    expect(session.title).toBe('Need help with session titles');
    expect(state.sessions.get(restoredResourceKey)?.title).toBe('Need help with session titles');
  });

  // =========================================================================
  // Title persistence tests — verify fix for titles reverting to placeholder
  // after tab switches (backend stores placeholder at create time).
  // =========================================================================

  it('derives title from history when backend returns placeholder title "New OpenCode Session"', async () => {
    state.backend.sessions.get = vi.fn(async () => ({
      data: { id: 'ses_placeholder', title: 'New OpenCode Session', createdAt: new Date('2026-05-28T03:00:00Z') },
    }));
    vi.mocked(readSessionEvents).mockResolvedValue([
      makeTextEvent('How do I fix the auth bug?') as any,
    ]);

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
    vi.mocked(readSessionEvents).mockResolvedValue([
      makeTextEvent('Refactor the database layer') as any,
    ]);

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

  it('prefers runtime non-placeholder title over placeholder when same sessionId has multiple entries', async () => {
    (state.sessionStore.listSessions as any).mockResolvedValue([
      { id: 'ses_dup', title: 'Derived From Prompt', createdAt: '2026-05-28T01:00:00.000Z', backendName: 'opencode' },
    ]);

    // Original tab entry with derived title
    state.sessions.set('opencode-copilot.opencode:/untitled-1', {
      sessionId: 'ses_dup',
      turnMap: [],
      title: 'Derived From Prompt',
      createdAt: new Date('2026-05-28T01:00:00Z'),
    });

    // Session list click created a duplicate entry with placeholder title
    state.sessions.set('opencode-copilot.opencode:/ses_dup', {
      sessionId: 'ses_dup',
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
    state.sessions.set('opencode-copilot.opencode:/untitled-1', {
      sessionId: 'ses_existing',
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
    expect(state.sessions.get(newKey)?.title).toBe('My original prompt title');
    expect(session.title).toBe('My original prompt title');
  });

  // =========================================================================
  // Agent filtering tests — ensures isUserSelectableAgent works correctly
  // for both hidden and subagent-mode agents.
  // =========================================================================

  describe('isUserSelectableAgent', () => {
    it('returns true for primary non-hidden agent', () => {
      const agent: AcpAgent = { id: 'primary-agent', mode: 'primary' };
      expect(isUserSelectableAgent(agent)).toBe(true);
    });

    it('returns true for agent with mode all and not hidden', () => {
      const agent: AcpAgent = { id: 'all-mode-agent', mode: 'all' };
      expect(isUserSelectableAgent(agent)).toBe(true);
    });

    it('returns false for hidden agent', () => {
      const agent: AcpAgent = { id: 'hidden-agent', hidden: true, mode: 'primary' };
      expect(isUserSelectableAgent(agent)).toBe(false);
    });

    it('returns false for subagent-mode agent', () => {
      const agent: AcpAgent = { id: 'subagent', mode: 'subagent' };
      expect(isUserSelectableAgent(agent)).toBe(false);
    });

    it('returns false for hidden subagent-mode agent', () => {
      const agent: AcpAgent = { id: 'hidden-subagent', hidden: true, mode: 'subagent' };
      expect(isUserSelectableAgent(agent)).toBe(false);
    });

    it('excludes hidden agents from filtered list', () => {
      const agents: AcpAgent[] = [
        { id: 'agent-1', mode: 'primary' },
        { id: 'agent-2', hidden: true, mode: 'primary' },
        { id: 'agent-3', mode: 'all' },
      ];
      const visible = agents.filter(isUserSelectableAgent);
      expect(visible).toHaveLength(2);
      expect(visible.map(a => a.id)).toEqual(['agent-1', 'agent-3']);
    });

    it('excludes subagent-mode agents from filtered list', () => {
      const agents: AcpAgent[] = [
        { id: 'primary-agent', mode: 'primary' },
        { id: 'sub-agent', mode: 'subagent' },
        { id: 'another-primary', mode: 'primary' },
      ];
      const visible = agents.filter(isUserSelectableAgent);
      expect(visible).toHaveLength(2);
      expect(visible.map(a => a.id)).toEqual(['primary-agent', 'another-primary']);
    });

    it('excludes both hidden and subagent agents together', () => {
      const agents: AcpAgent[] = [
        { id: 'good', mode: 'primary' },
        { id: 'hidden-primary', hidden: true, mode: 'primary' },
        { id: 'sub', mode: 'subagent' },
        { id: 'hidden-sub', hidden: true, mode: 'subagent' },
        { id: 'all-mode', mode: 'all' },
      ];
      const visible = agents.filter(isUserSelectableAgent);
      expect(visible).toHaveLength(2);
      expect(visible.map(a => a.id)).toEqual(['good', 'all-mode']);
    });
  });
});
