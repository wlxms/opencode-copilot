import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be before all imports
// ---------------------------------------------------------------------------

const mockSdkClient = {
  session: {
    create: vi.fn(),
    prompt: vi.fn(),
    promptAsync: vi.fn(),
    messages: vi.fn(),
    status: vi.fn(),
    abort: vi.fn(),
    fork: vi.fn(),
    revert: vi.fn(),
    deleteMessage: vi.fn(),
  },
  event: {
    subscribe: vi.fn(),
  },
};

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { createParticipantHandler } from '../participant/handler';
import type { ExtensionState } from '../types';

/** Helper: set up standard promptAsync + messages + status mocks */
function setupPromptMock(
  parts: Array<Record<string, any>> = [],
  sessionId: string = 'session-1',
) {
  mockSdkClient.session.promptAsync.mockResolvedValue({});
  mockSdkClient.session.messages.mockResolvedValue({
    data: [{ info: { role: 'assistant', id: 'msg-asst-1' }, parts }],
  });
  mockSdkClient.session.status.mockResolvedValue({
    data: { [sessionId]: { type: 'idle' } },
  });
  mockSdkClient.session.abort.mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


/** Create a SessionState object for test convenience */
function sessionState(id: string, turnMap: Array<{ vscodeTurn: number; opencodeMessageId: string }> = []) {
  return { opencodeSessionId: id, turnMap };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createParticipantHandler', () => {
  let state: ExtensionState;
  let stream: vscode.ChatResponseStream;
  let token: vscode.CancellationToken;
  let mockServerManager: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    isRunning: ReturnType<typeof vi.fn>;
    getUrl: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    getClient: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.resetAllMocks();

    mockServerManager = {
      start: vi.fn(),
      stop: vi.fn(),
      isRunning: vi.fn().mockReturnValue(false),
      getUrl: vi.fn().mockReturnValue('http://127.0.0.1:51777'),
      getStatus: vi.fn().mockReturnValue('stopped'),
      getClient: vi.fn(),
    };

    state = {
      serverManager: mockServerManager,
      client: null,
      activeSessionId: null,
      serverStatus: 'stopped',
      sessionMap: new Map(),
      outputChannel: {
        name: 'test',
        lines: [] as string[],
        appendLine: vi.fn(),
        append: vi.fn(),
        clear: vi.fn(),
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
      } as unknown as vscode.OutputChannel,
    };

    stream = {
      markdown: vi.fn(),
      progress: vi.fn(),
      push: vi.fn(),
    };

    token = {
      isCancellationRequested: false,
      onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
    };

    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: { fsPath: '/test/workspace' } as vscode.Uri, name: 'test', index: 0 },
    ];
  });

  // -----------------------------------------------------------------------
  // Factory / Cancellation / Empty prompt / Slash commands
  // -----------------------------------------------------------------------

  it('should return a function', () => {
    expect(typeof createParticipantHandler(state)).toBe('function');
  });

  it('should return early on cancellation', async () => {
    const handler = createParticipantHandler(state);
    const cancelledToken: vscode.CancellationToken = {
      isCancellationRequested: true,
      onCancellationRequested: vi.fn(),
    };
    const result = await handler(
      { prompt: 'hello', command: undefined, references: [], sessionId: 'test-chat-1' },
      { history: [] }, stream, cancelledToken,
    );
    expect(result).toEqual({ metadata: {} });
    expect(mockServerManager.start).not.toHaveBeenCalled();
  });

  it('should return early for empty prompt', async () => {
    const handler = createParticipantHandler(state);
    await handler(
      { prompt: '', command: undefined, references: [], sessionId: 'test-chat-1' },
      { history: [] }, stream, token,
    );
    expect(stream.markdown).toHaveBeenCalledWith(expect.stringContaining('/help'));
  });

  it('should return early for whitespace-only prompt', async () => {
    const handler = createParticipantHandler(state);
    await handler(
      { prompt: '   ', command: undefined, references: [], sessionId: 'test-chat-1' },
      { history: [] }, stream, token,
    );
    expect(stream.markdown).toHaveBeenCalledWith(expect.stringContaining('/help'));
  });

  it('should route slash commands', async () => {
    const handler = createParticipantHandler(state);
    await handler(
      { prompt: '/help', command: 'help', references: [], sessionId: 'test-chat-1' },
      { history: [] }, stream, token,
    );
    expect(stream.markdown).toHaveBeenCalledWith(expect.stringContaining('/new'));
  });

  // -----------------------------------------------------------------------
  // Full flow — start server, create session, send message
  // -----------------------------------------------------------------------

  it('should start server and create session for new chat', async () => {
    const handler = createParticipantHandler(state);
    mockServerManager.start.mockResolvedValue('http://127.0.0.1:51777');
    mockServerManager.getClient.mockReturnValue(mockSdkClient);
    mockSdkClient.session.create.mockResolvedValue({ data: { id: 'session-1' } });
    setupPromptMock(
      [{ type: 'text', id: 'p1', messageID: 'msg-2', text: 'Hello!' }],
      'session-1',
    );

    const result = await handler(
      { prompt: 'write a test', command: undefined, references: [], sessionId: 'chat-new' },
      { history: [] }, stream, token,
    );

    expect(mockServerManager.start).toHaveBeenCalledOnce();
    expect(state.serverStatus).toBe('running');
    expect(state.client).toBe(mockSdkClient);
    expect(mockSdkClient.session.create).toHaveBeenCalledWith({
      body: {},
      query: { directory: '/test/workspace' },
    });
    expect(state.activeSessionId).toBe('session-1');
    expect(state.sessionMap.get('chat-new')?.opencodeSessionId).toBe('session-1');
    expect(mockSdkClient.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      body: { parts: [{ type: 'text', text: 'write a test' }] },
      query: { directory: '/test/workspace' },
    });
    // Response parts should be rendered to stream
    expect(stream.markdown).toHaveBeenCalledWith('Hello!');
    // Turn map recorded from the first part's messageID
    expect(state.sessionMap.get('chat-new')?.turnMap).toEqual([
      { vscodeTurn: 0, opencodeMessageId: 'msg-2' },
    ]);
    expect(result.metadata).toHaveProperty('sessionId', 'session-1');
  });

  // -----------------------------------------------------------------------
  // Multi-turn — reuse via sessionMap
  // -----------------------------------------------------------------------

  it('should reuse session for multi-turn conversation', async () => {
    state.activeSessionId = 'existing-session';
    state.serverStatus = 'running';
    state.client = mockSdkClient;
    state.sessionMap.set('chat-multi', sessionState('existing-session'));

    const handler = createParticipantHandler(state);
    setupPromptMock(
      [{ type: 'text', id: 'p1', messageID: 'msg-ai-2', text: 'Response to follow up' }],
      'existing-session',
    );

    const priorResponseTurn = new vscode.ChatResponseTurn({
      metadata: { sessionId: 'existing-session', turnMap: [{ vscodeTurn: 0, opencodeMessageId: 'msg-0' }] },
    });

    const result = await handler(
      { prompt: 'follow up', command: undefined, references: [], sessionId: 'chat-multi' },
      { history: [new vscode.ChatRequestTurn('first message'), priorResponseTurn] },
      stream, token,
    );

    expect(mockServerManager.start).not.toHaveBeenCalled();
    expect(mockSdkClient.session.create).not.toHaveBeenCalled();
    expect(mockSdkClient.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'existing-session' },
      body: { parts: [{ type: 'text', text: 'follow up' }] },
      query: { directory: '/test/workspace' },
    });
    expect(stream.markdown).toHaveBeenCalledWith('Response to follow up');
    expect(result.metadata).toHaveProperty('sessionId', 'existing-session');
  });

  // -----------------------------------------------------------------------
  // Client not available / Server start failure / Error handling
  // -----------------------------------------------------------------------

  it('should show error when client not available after start', async () => {
    const handler = createParticipantHandler(state);
    mockServerManager.start.mockResolvedValue('http://127.0.0.1:51777');
    mockServerManager.getClient.mockReturnValue(null);
    await handler(
      { prompt: 'hello', command: undefined, references: [], sessionId: 'test-chat-1' },
      { history: [] }, stream, token,
    );
    expect(stream.markdown).toHaveBeenCalledWith(expect.stringContaining('client not available'));
  });

  it('should show error when server fails to start', async () => {
    const handler = createParticipantHandler(state);
    mockServerManager.start.mockRejectedValue(new Error('OpenCode CLI not found'));
    await handler(
      { prompt: 'hello', command: undefined, references: [], sessionId: 'test-chat-1' },
      { history: [] }, stream, token,
    );
    expect(stream.markdown).toHaveBeenCalledWith(expect.stringContaining('Failed to start OpenCode'));
  });

  it('should catch errors and show them', async () => {
    const handler = createParticipantHandler(state);
    mockServerManager.start.mockResolvedValue('http://127.0.0.1:51777');
    mockServerManager.getClient.mockReturnValue(mockSdkClient);
    mockSdkClient.session.create.mockRejectedValue(new Error('Session limit reached'));
    await handler(
      { prompt: 'hello', command: undefined, references: [], sessionId: 'test-chat-1' },
      { history: [] }, stream, token,
    );
    expect(stream.markdown).toHaveBeenCalledWith(expect.stringContaining('Session limit reached'));
  });

  it('should handle non-Error thrown values', async () => {
    const handler = createParticipantHandler(state);
    mockServerManager.start.mockRejectedValue('string error');
    await handler(
      { prompt: 'hello', command: undefined, references: [], sessionId: 'test-chat-1' },
      { history: [] }, stream, token,
    );
    expect(stream.markdown).toHaveBeenCalledWith(expect.stringContaining('Failed to start OpenCode'));
  });

  // -----------------------------------------------------------------------
  // Already running — skip server start, reuse session
  // -----------------------------------------------------------------------

  it('should skip server start if already running with client', async () => {
    state.serverStatus = 'running';
    state.client = mockSdkClient;
    state.sessionMap.set('chat-skip', sessionState('existing-id'));

    const handler = createParticipantHandler(state);
    setupPromptMock([], 'existing-id');

    const priorResponseTurn = new vscode.ChatResponseTurn({
      metadata: { sessionId: 'existing-id', turnMap: [{ vscodeTurn: 0, opencodeMessageId: 'msg-0' }] },
    });

    await handler(
      { prompt: 'question', command: undefined, references: [], sessionId: 'chat-skip' },
      { history: [new vscode.ChatRequestTurn('prior question'), priorResponseTurn] },
      stream, token,
    );

    expect(mockServerManager.start).not.toHaveBeenCalled();
    expect(mockSdkClient.session.create).not.toHaveBeenCalled();
    expect(mockSdkClient.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'existing-id' },
      body: { parts: [{ type: 'text', text: 'question' }] },
      query: { directory: '/test/workspace' },
    });
  });

  // -----------------------------------------------------------------------
  // New VSCode chat (new sessionId) — creates new session
  // -----------------------------------------------------------------------

  it('should create new session when sessionId not in sessionMap', async () => {
    state.serverStatus = 'running';
    state.client = mockSdkClient;
    state.sessionMap.set('old-chat', sessionState('original-session'));

    const handler = createParticipantHandler(state);
    mockSdkClient.session.create.mockResolvedValue({ data: { id: 'new-session' } });
    setupPromptMock([], 'new-session');

    const result = await handler(
      { prompt: 'fresh start', command: undefined, references: [], sessionId: 'brand-new-chat' },
      { history: [] }, stream, token,
    );

    expect(mockSdkClient.session.fork).not.toHaveBeenCalled();
    expect(mockSdkClient.session.create).toHaveBeenCalledWith({
      body: {},
      query: { directory: '/test/workspace' },
    });
    expect(state.activeSessionId).toBe('new-session');
    const cs = state.sessionMap.get('brand-new-chat');
    expect(cs?.opencodeSessionId).toBe('new-session');
    expect(cs?.turnMap).toEqual([]);
    expect(result.metadata).toHaveProperty('sessionId', 'new-session');
  });

  // -----------------------------------------------------------------------
  // Rewind to position 0 — new sessionId creates new session
  // -----------------------------------------------------------------------

  it('should create new session when history empty and sessionId not in sessionMap', async () => {
    state.serverStatus = 'running';
    state.client = mockSdkClient;
    state.sessionMap.set('old-chat-2', sessionState('original-session-2'));

    const handler = createParticipantHandler(state);
    mockSdkClient.session.create.mockResolvedValue({ data: { id: 'rewound-session' } });
    setupPromptMock([], 'rewound-session');

    const result = await handler(
      { prompt: 'rewound message', command: undefined, references: [], sessionId: 'new-chat-2' },
      { history: [] }, stream, token,
    );

    expect(mockSdkClient.session.fork).not.toHaveBeenCalled();
    expect(mockSdkClient.session.create).toHaveBeenCalledWith({
      body: {},
      query: { directory: '/test/workspace' },
    });
    expect(state.activeSessionId).toBe('rewound-session');
    expect(state.sessionMap.get('new-chat-2')?.opencodeSessionId).toBe('rewound-session');
    expect(state.sessionMap.get('new-chat-2')?.turnMap).toEqual([]);
    expect(result.metadata).toHaveProperty('sessionId', 'rewound-session');
  });

  // -----------------------------------------------------------------------
  // Rewind to middle — revert messages and stay in same session
  // -----------------------------------------------------------------------

  it('should revert messages when rewinding to middle of conversation', async () => {
    state.serverStatus = 'running';
    state.client = mockSdkClient;
    state.sessionMap.set('chat-fork', sessionState('original-session', [
      { vscodeTurn: 0, opencodeMessageId: 'msg-0' },
      { vscodeTurn: 1, opencodeMessageId: 'msg-1' },
      { vscodeTurn: 2, opencodeMessageId: 'msg-2' },
    ]));

    const handler = createParticipantHandler(state);
    mockSdkClient.session.revert.mockResolvedValue({ data: { id: 'original-session' } });
    setupPromptMock([], 'original-session');

    const priorResponseTurn = new vscode.ChatResponseTurn({
      metadata: {
        sessionId: 'original-session',
        turnMap: [
          { vscodeTurn: 0, opencodeMessageId: 'msg-0' },
          { vscodeTurn: 1, opencodeMessageId: 'msg-1' },
          { vscodeTurn: 2, opencodeMessageId: 'msg-2' },
        ],
      },
    });

    await handler(
      { prompt: 'edited message', command: undefined, references: [], sessionId: 'chat-fork' },
      { history: [new vscode.ChatRequestTurn('first message'), priorResponseTurn] },
      stream, token,
    );

    // Should revert msg-2 then msg-1 (undo from last to first)
    expect(mockSdkClient.session.revert).toHaveBeenCalledTimes(2);
    expect(mockSdkClient.session.revert).toHaveBeenNthCalledWith(1, {
      path: { id: 'original-session' },
      body: { messageID: 'msg-2' },
      query: { directory: '/test/workspace' },
    });
    expect(mockSdkClient.session.revert).toHaveBeenNthCalledWith(2, {
      path: { id: 'original-session' },
      body: { messageID: 'msg-1' },
      query: { directory: '/test/workspace' },
    });

    // Same session, turnMap trimmed
    const cs = state.sessionMap.get('chat-fork');
    expect(cs?.opencodeSessionId).toBe('original-session');
    expect(cs?.turnMap).toEqual([{ vscodeTurn: 0, opencodeMessageId: 'msg-0' }]);
    expect(state.activeSessionId).toBe('original-session');
  });
});
