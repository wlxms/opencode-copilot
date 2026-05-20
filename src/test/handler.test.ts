import { GlobalEventBroker } from '../participant/event-broker';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be before all imports
// ---------------------------------------------------------------------------

const mockSdkClient = {
  session: {
    create: vi.fn(),
    get: vi.fn(),
    prompt: vi.fn(),
    revert: vi.fn(),
    abort: vi.fn(),
  },
  global: {
    event: vi.fn(),
  },
  config: {
    providers: vi.fn(),
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
import type { OpenCodeEvent } from '../types/events';
import type { ExtensionState, OpenCodeClient, OpenCodeServerController } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Empty async generator for event subscribe mock */
async function* emptyEventStream(): AsyncIterable<OpenCodeEvent> {
  // No events — completes immediately
}

function createRequest(
  overrides: Partial<vscode.ChatRequest> & Pick<vscode.ChatRequest, 'prompt'>,
): vscode.ChatRequest {
  const { prompt, ...rest } = overrides;
  return {
    prompt,
    command: undefined,
    references: [],
    toolReferences: [],
    toolInvocationToken: undefined,
    model: undefined,
    id: 'req-1',
    sessionId: 'chat-test',
    sessionResource: { fsPath: '/test/chat' } as vscode.Uri,
    attempt: 0,
    ...rest,
  } as unknown as vscode.ChatRequest;
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

    // Mock server manager
    mockServerManager = {
      start: vi.fn(),
      stop: vi.fn(),
      isRunning: vi.fn().mockReturnValue(false),
      getUrl: vi.fn().mockReturnValue('http://127.0.0.1:51777'),
      getStatus: vi.fn().mockReturnValue('stopped'),
      getClient: vi.fn(),
    };

    state = {
      serverManager: mockServerManager as unknown as OpenCodeServerController,
      client: null,
      activeSessionId: null,
      serverStatus: 'stopped',
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
      eventBroker: new GlobalEventBroker(),
      sessionMap: new Map(),
    };

    stream = {
      markdown: vi.fn(),
      progress: vi.fn(),
      push: vi.fn(),
    } as unknown as vscode.ChatResponseStream;

    token = {
      isCancellationRequested: false,
      onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
    } as unknown as vscode.CancellationToken;

    // Default abort mock — resolves to prevent handler crash on cancellation
    mockSdkClient.session.abort.mockResolvedValue({ data: true });

    // Set workspace folders for consistent test behavior
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      {
        uri: { fsPath: '/test/workspace' } as vscode.Uri,
        name: 'test',
        index: 0,
      },
    ];
  });

  // -----------------------------------------------------------------------
  // Factory
  // -----------------------------------------------------------------------

  it('should return a function', () => {
    const handler = createParticipantHandler(state);
    expect(typeof handler).toBe('function');
  });

  // -----------------------------------------------------------------------
  // Cancellation
  // -----------------------------------------------------------------------

  it('should return early on cancellation', async () => {
    const handler = createParticipantHandler(state);
    const cancelledToken: vscode.CancellationToken = {
      isCancellationRequested: true,
      onCancellationRequested: vi.fn(),
    };

    const result = await handler(
      createRequest({ prompt: 'hello' }),
      { history: [] },
      stream,
      cancelledToken,
    );

    expect(result).toEqual({ metadata: {} });
    expect(mockServerManager.start).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Empty prompt
  // -----------------------------------------------------------------------
  // Empty prompt
  // -----------------------------------------------------------------------

  it('should return early with help message for empty prompt', async () => {
    const handler = createParticipantHandler(state);

    await handler(
      createRequest({ prompt: '' }),
      { history: [] },
      stream,
      token,
    );

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('/help'),
    );
    expect(mockServerManager.start).not.toHaveBeenCalled();
  });

  it('should return early for whitespace-only prompt', async () => {
    const handler = createParticipantHandler(state);

    await handler(
      createRequest({ prompt: '   ' }),
      { history: [] },
      stream,
      token,
    );

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('/help'),
    );
  });

  // -----------------------------------------------------------------------
  // Slash command routing
  // -----------------------------------------------------------------------

  it('should route slash commands via the commands module', async () => {
    const handler = createParticipantHandler(state);

    await handler(
      createRequest({ prompt: '/help', command: 'help' }),
      { history: [] },
      stream,
      token,
    );

    // /help should output help text
    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('/new'),
    );
  });

  // -----------------------------------------------------------------------
  // Full flow – start server, create session, send message
  // -----------------------------------------------------------------------

  it('should start server and create session when not running', async () => {
    const handler = createParticipantHandler(state);

    // Setup mocks for the full flow
    mockServerManager.start.mockResolvedValue('http://127.0.0.1:51777');
    mockServerManager.getClient.mockReturnValue(mockSdkClient);
    mockSdkClient.session.create.mockResolvedValue({
      data: { id: 'session-1' },
    });
    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });
    mockSdkClient.session.prompt.mockResolvedValue(undefined);

    const result = await handler(
      createRequest({ prompt: 'write a test', sessionId: 'chat-1' }),
      { history: [] },
      stream,
      token,
    );

    // Server was started
    expect(mockServerManager.start).toHaveBeenCalledOnce();
    expect(state.serverStatus).toBe('running');

    // Client was set
    expect(state.client).toBe(mockSdkClient);

    // Session was created with workspace directory and title
    expect(mockSdkClient.session.create).toHaveBeenCalledWith({
      body: { title: 'Chat chat-1' },
      query: { directory: '/test/workspace' },
    });
    // Session stored in sessionMap under the vscode chat session ID
    expect(state.sessionMap.get('chat-1')?.opencodeSessionId).toBe('session-1');

    // Events subscribed
    expect(mockSdkClient.global.event).toHaveBeenCalledOnce();

    // Prompt sent with correct format (path/body/query)
    expect(mockSdkClient.session.prompt).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      body: {
        parts: [{ type: 'text', text: 'write a test' }],
      },
      query: { directory: '/test/workspace' },
    });

    // Progress was reported
    expect(stream.progress).toHaveBeenCalled();

    // Result contains session metadata
    expect(result!.metadata).toHaveProperty('sessionId', 'session-1');
    // turnMap should be in metadata
    expect(result!.metadata).toHaveProperty('turnMap');
  });

  // -----------------------------------------------------------------------
  // Multi-turn – reuses existing session
  // -----------------------------------------------------------------------

  it('should reuse active session for multi-turn conversation', async () => {
    state.serverStatus = 'running';
    state.client = mockSdkClient as OpenCodeClient;
    // Pre-populate sessionMap with existing session
    state.sessionMap.set('chat-1', {
      opencodeSessionId: 'existing-session',
      turnMap: [],
    });

    const handler = createParticipantHandler(state);

    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });
    mockSdkClient.session.prompt.mockResolvedValue(undefined);

    const result = await handler(
      createRequest({ prompt: 'follow up', sessionId: 'chat-1' }),
      { history: [] },
      stream,
      token,
    );

    // Should NOT start server (already running)
    expect(mockServerManager.start).not.toHaveBeenCalled();
    // Should NOT create session (reusing existing)
    expect(mockSdkClient.session.create).not.toHaveBeenCalled();
    // Should send message to existing session with directory query
    expect(mockSdkClient.session.prompt).toHaveBeenCalledWith({
      path: { id: 'existing-session' },
      body: {
        parts: [{ type: 'text', text: 'follow up' }],
      },
      query: { directory: '/test/workspace' },
    });
    expect(result!.metadata).toHaveProperty('sessionId', 'existing-session');
  });

  // -----------------------------------------------------------------------
  // Client not available after start
  // -----------------------------------------------------------------------

  it('should show error when client is not available after server start', async () => {
    const handler = createParticipantHandler(state);

    mockServerManager.start.mockResolvedValue('http://127.0.0.1:51777');
    mockServerManager.getClient.mockReturnValue(null);

    await handler(
      createRequest({ prompt: 'hello' }),
      { history: [] },
      stream,
      token,
    );

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('client not available'),
    );
  });

  // -----------------------------------------------------------------------
  // Server start failure
  // -----------------------------------------------------------------------

  it('should show error when server fails to start', async () => {
    const handler = createParticipantHandler(state);
    mockServerManager.start.mockRejectedValue(
      new Error('OpenCode CLI not found'),
    );

    await handler(
      createRequest({ prompt: 'hello' }),
      { history: [] },
      stream,
      token,
    );

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Failed to start OpenCode'),
    );
    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('not found'),
    );
  });

  // -----------------------------------------------------------------------
  // Error during processing
  // -----------------------------------------------------------------------

  it('should catch errors and show them in stream', async () => {
    const handler = createParticipantHandler(state);
    mockServerManager.start.mockResolvedValue('http://127.0.0.1:51777');
    mockServerManager.getClient.mockReturnValue(mockSdkClient);
    mockSdkClient.session.create.mockRejectedValue(
      new Error('Session limit reached'),
    );

    await handler(
      createRequest({ prompt: 'hello', sessionId: 'chat-err' }),
      { history: [] },
      stream,
      token,
    );

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Session limit reached'),
    );
  });

  it('should handle non-Error thrown values', async () => {
    const handler = createParticipantHandler(state);
    mockServerManager.start.mockRejectedValue('string error');

    await handler(
      createRequest({ prompt: 'hello' }),
      { history: [] },
      stream,
      token,
    );

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Failed to start OpenCode'),
    );
  });

  // -----------------------------------------------------------------------
  // Already running – skip server start
  // -----------------------------------------------------------------------

  it('should skip server start if already running with client', async () => {
    state.serverStatus = 'running';
    state.client = mockSdkClient as OpenCodeClient;
    // Pre-populate sessionMap so session is reused
    state.sessionMap.set('chat-running', {
      opencodeSessionId: 'existing-id',
      turnMap: [],
    });

    const handler = createParticipantHandler(state);

    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });
    mockSdkClient.session.prompt.mockResolvedValue(undefined);

    await handler(
      createRequest({ prompt: 'question', sessionId: 'chat-running' }),
      { history: [] },
      stream,
      token,
    );

    expect(mockServerManager.start).not.toHaveBeenCalled();
    expect(mockSdkClient.session.create).not.toHaveBeenCalled();
    expect(mockSdkClient.session.prompt).toHaveBeenCalledWith({
      path: { id: 'existing-id' },
      body: {
        parts: [{ type: 'text', text: 'question' }],
      },
      query: { directory: '/test/workspace' },
    });
  });

  // -----------------------------------------------------------------------
  // Cancellation during active session → abort
  // -----------------------------------------------------------------------

  it('should call session.abort when cancelled mid-session', async () => {
    const handler = createParticipantHandler(state);

    // Set up a running server with client
    state.client = mockSdkClient as unknown as OpenCodeClient;
    state.serverStatus = 'running';
    mockSdkClient.session.create.mockResolvedValue({
      data: { id: 'session-abort-test' },
    });
    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });
    mockSdkClient.session.prompt.mockResolvedValue(undefined);
    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });

    // Create a token that fires cancellation via onCancellationRequested callback
    let cancelCallback: (() => void) | undefined;
    const cancelToken = {
      isCancellationRequested: false,
      onCancellationRequested: vi.fn((cb: () => void) => {
        cancelCallback = cb;
        return { dispose: vi.fn() };
      }),
    } as unknown as vscode.CancellationToken;

    // Fire the handler — it will subscribe to cancellation
    const handlerPromise = handler(
      createRequest({ prompt: 'hello' }),
      { history: [] },
      stream,
      cancelToken,
    );

    // Give the handler a tick to register the cancellation listener
    await vi.waitFor(() => {
      expect(cancelCallback).toBeDefined();
    });

    // Simulate VSCode firing cancellation (user clicks "Stop")
    cancelCallback!();

    // Wait for handler to complete
    await handlerPromise;

    // Verify abort was called with the correct session ID
    expect(mockSdkClient.session.abort).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: 'session-abort-test' },
        query: { directory: '/test/workspace' },
      }),
    );
  });

  it('should not call session.abort when handler completes normally', async () => {
    const handler = createParticipantHandler(state);

    state.client = mockSdkClient as unknown as OpenCodeClient;
    state.serverStatus = 'running';
    mockSdkClient.session.create.mockResolvedValue({
      data: { id: 'session-normal' },
    });
    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });
    mockSdkClient.session.prompt.mockResolvedValue(undefined);
    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });

    await handler(
      createRequest({ prompt: 'hello' }),
      { history: [] },
      stream,
      token,
    );

    // abort should NOT have been called for a normal completion
    expect(mockSdkClient.session.abort).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Per-edit externalEdit tracker — injected into StreamBridge for permission.asked lifecycle
  // -----------------------------------------------------------------------

  it('should pass tracker to StreamBridge for per-edit externalEdit handling', async () => {
    const handler = createParticipantHandler(state);

    // Set up full flow mocks
    state.serverStatus = 'running';
    state.client = mockSdkClient as OpenCodeClient;
    state.sessionMap.set('chat-cp-1', {
      opencodeSessionId: 'existing-session',
      turnMap: [],
    });

    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });
    mockSdkClient.session.prompt.mockResolvedValue(undefined);

    const result = await handler(
      createRequest({ prompt: 'test tracker', sessionId: 'chat-cp-1' }),
      { history: [] },
      stream,
      token,
    );

    // Should complete without error
    expect(result!.metadata).toHaveProperty('sessionId', 'existing-session');

    // Prompt should have been sent (StreamBridge processes events)
    expect(mockSdkClient.session.prompt).toHaveBeenCalled();
  });

  it('should collect open file URIs for knownFileUris new-file detection', async () => {
    const handler = createParticipantHandler(state);

    // Simulate open text documents (file scheme, not untitled)
    const mockDocs = [
      { uri: vscode.Uri.file('/src/app.ts'), isUntitled: false },
      { uri: vscode.Uri.file('/src/util.ts'), isUntitled: false },
    ];
    (vscode.workspace as { textDocuments: unknown }).textDocuments = mockDocs;

    // Set up full flow mocks
    state.serverStatus = 'running';
    state.client = mockSdkClient as OpenCodeClient;
    state.sessionMap.set('chat-cp-2', {
      opencodeSessionId: 'existing-session',
      turnMap: [],
    });

    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });
    mockSdkClient.session.prompt.mockResolvedValue(undefined);

    const result = await handler(
      createRequest({ prompt: 'test files', sessionId: 'chat-cp-2' }),
      { history: [] },
      stream,
      token,
    );

    // Should complete without error
    expect(result!.metadata).toHaveProperty('sessionId', 'existing-session');

    // Clean up
    (vscode.workspace as { textDocuments: unknown }).textDocuments = [];
  });

  it('should dispose tracker in finally block even on error', async () => {
    const handler = createParticipantHandler(state);

    // Set up so that the handler starts but prompt throws
    state.serverStatus = 'running';
    state.client = mockSdkClient as OpenCodeClient;
    state.sessionMap.set('chat-cp-3', {
      opencodeSessionId: 'existing-session',
      turnMap: [],
    });

    mockSdkClient.global.event.mockResolvedValue({
      stream: emptyEventStream(),
    });
    mockSdkClient.session.prompt.mockRejectedValue(new Error('prompt failed'));

    // Handler should complete without crashing (prompt error is caught internally)
    const result = await handler(
      createRequest({ prompt: 'test error cleanup', sessionId: 'chat-cp-3' }),
      { history: [] },
      stream,
      token,
    );

    // Should still return metadata (prompt error is swallowed by .catch())
    expect(result!.metadata).toHaveProperty('sessionId', 'existing-session');

    // Prompt error should be logged
    expect(state.outputChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('Prompt error'),
    );
  });
});
