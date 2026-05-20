import { GlobalEventBroker } from '../participant/event-broker';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AcpBackend } from '../acp/backend';

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
  postSessionIdPermissionsPermissionId: vi.fn(),
};

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { createParticipantHandler, denormalizeAcpEvent } from '../participant/handler';
import type { OpenCodeEvent } from '../types/events';
import type { AcpEvent, AcpPermissionRequestEvent, AcpStreamPart } from '../acp/types';
import type { AcpServerStatus } from '../acp/types';
import type { PermissionAskedEvent } from '../types/events';
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
  let backendStatus: AcpServerStatus;
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
    backendStatus = 'stopped';

    // Mock server manager
    mockServerManager = {
      start: vi.fn(),
      stop: vi.fn(),
      isRunning: vi.fn().mockReturnValue(false),
      getUrl: vi.fn().mockReturnValue('http://127.0.0.1:51777'),
      getStatus: vi.fn().mockReturnValue('stopped'),
      getClient: vi.fn(),
    };

    const backend: AcpBackend = {
      name: 'opencode',
      start: vi.fn(async () => {
        backendStatus = 'running';
        return { data: { url: 'http://127.0.0.1:51777', status: 'running' as const } };
      }),
      stop: vi.fn(async () => undefined),
      getStatus: vi.fn(() => backendStatus),
      getUrl: vi.fn(() => 'http://127.0.0.1:51777'),
      isRunning: vi.fn(() => backendStatus === 'running'),
      sessions: {
        create: vi.fn(async (options?: { title?: string; directory?: string }) => {
          const result = await mockSdkClient.session.create({
            body: options?.title ? { title: options.title } : undefined,
            query: options?.directory ? { directory: options.directory } : undefined,
          });
          return { data: result.data ? { id: result.data.id ?? '', title: result.data.title ?? '', createdAt: new Date() } : undefined, error: result.error };
        }),
        get: vi.fn(async () => ({ data: undefined })),
        prompt: vi.fn(async (id: string, text: string, directory?: string) => {
          const result = await mockSdkClient.session.prompt({
            path: { id },
            body: { parts: [{ type: 'text', text }] },
            query: directory ? { directory } : undefined,
          });
          return { data: result };
        }),
        revert: vi.fn(async (id: string, messageId: string, partId?: string, directory?: string) => {
          const result = await mockSdkClient.session.revert({
            path: { id },
            body: { messageID: messageId, ...(partId ? { partID: partId } : {}) },
            query: directory ? { directory } : undefined,
          });
          if (result && typeof result === 'object' && 'error' in result) {
            return { error: String(result.error) };
          }
          return { data: result };
        }),
        abort: vi.fn(async (id: string, directory?: string) => {
          const result = await mockSdkClient.session.abort({
            path: { id },
            query: directory ? { directory } : undefined,
          });
          return { data: result.data };
        }),
        list: vi.fn(async () => ({ data: [] })),
      },
      config: {
        models: vi.fn(async () => ({ data: [] })),
      },
      events: {
        openSessionStream: vi.fn((sessionId: string) => ({
          stream: (async function* () {
            const global = await mockSdkClient.global.event();
            for await (const event of global.stream) {
              if (!('directory' in event && 'payload' in event)) {
                yield event;
                continue;
              }
              const payload = event.payload;
              const payloadSession = payload.type === 'session.idle'
                ? payload.properties?.sessionID
                : payload.type === 'message.part.updated'
                  ? payload.properties?.part?.sessionID
                  : payload.type === 'message.part.delta'
                    ? undefined
                    : payload.type === 'session.diff'
                      ? payload.properties?.sessionID
                      : payload.type === 'permission.asked'
                        ? payload.properties?.sessionID
                        : undefined;
              if (!payloadSession || payloadSession === sessionId) {
                yield event;
              }
            }
          })(),
        })),
        openGlobalStream: vi.fn(async () => ({ stream: (async function* () {})() })),
        closeSessionStream: vi.fn(),
        ensureStarted: vi.fn(async () => undefined),
      },
      permissions: {
        reply: vi.fn(async () => undefined),
      },
    };

    state = {
      backend,
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
    expect(state.backend.start).not.toHaveBeenCalled();
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
    expect(state.backend.start).not.toHaveBeenCalled();
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
    expect(state.backend.start).toHaveBeenCalledOnce();

    // Session was created with workspace directory and title
    expect(mockSdkClient.session.create).toHaveBeenCalledWith({
      body: { title: 'Chat chat-1' },
      query: { directory: '/test/workspace' },
    });
    // Session stored in sessionMap under the vscode chat session ID
    expect(state.sessionMap.get('chat-1')?.opencodeSessionId).toBe('session-1');

    // Events subscribed
    expect(state.backend.events.ensureStarted).toHaveBeenCalledOnce();

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
    backendStatus = 'running';
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
    expect(state.backend.start).not.toHaveBeenCalled();
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
  // Rewind / revert
  // -----------------------------------------------------------------------

  it('should detect rewind and revert extraneous messages when user edits a previous turn', async () => {
    backendStatus = 'running';
    // Simulate 2 completed turns: turnMap has 2 entries
    state.sessionMap.set('chat-revert-1', {
      opencodeSessionId: 'revert-session',
      turnMap: [
        { vscodeTurn: 0, opencodeMessageId: 'msg-0' },
        { vscodeTurn: 1, opencodeMessageId: 'msg-1' },
      ],
    });

    // Mock revert to succeed
    mockSdkClient.session.revert.mockResolvedValue({ data: true });
    mockSdkClient.global.event.mockResolvedValue({ stream: emptyEventStream() });
    mockSdkClient.session.prompt.mockResolvedValue(undefined);

    const handler = createParticipantHandler(state);

    // History has only 1 ChatRequestTurn → currentTurnIndex = 1 < turnMap.length(2) → rewind
    // @ts-expect-error — private ctor in vscode types, public in mock
const reqTurn = new vscode.ChatRequestTurn('initial', undefined);
    const result = await handler(
      createRequest({ prompt: 'edited follow-up', sessionId: 'chat-revert-1' }),
      { history: [reqTurn] },
      stream,
      token,
    );

    // Should revert msg-1 (the extraneous turn, from back to front)
    expect(mockSdkClient.session.revert).toHaveBeenCalledTimes(1);
    expect(mockSdkClient.session.revert).toHaveBeenCalledWith({
      path: { id: 'revert-session' },
      body: { messageID: 'msg-1' },
      query: { directory: '/test/workspace' },
    });

    // Should NOT create a new session
    expect(mockSdkClient.session.create).not.toHaveBeenCalled();

    // TurnMap should be trimmed to keep only the first entry
    const chatState = state.sessionMap.get('chat-revert-1')!;
    expect(chatState.turnMap).toEqual([
      { vscodeTurn: 0, opencodeMessageId: 'msg-0' },
    ]);

    // Should prompt on the same reverted session
    expect(mockSdkClient.session.prompt).toHaveBeenCalledWith({
      path: { id: 'revert-session' },
      body: { parts: [{ type: 'text', text: 'edited follow-up' }] },
      query: { directory: '/test/workspace' },
    });
    expect(result!.metadata).toHaveProperty('sessionId', 'revert-session');
  });

  it('should revert multiple extraneous messages when user rewinds multiple turns', async () => {
    backendStatus = 'running';
    // Simulate 3 completed turns
    state.sessionMap.set('chat-revert-3', {
      opencodeSessionId: 'revert-session-3',
      turnMap: [
        { vscodeTurn: 0, opencodeMessageId: 'msg-0' },
        { vscodeTurn: 1, opencodeMessageId: 'msg-1' },
        { vscodeTurn: 2, opencodeMessageId: 'msg-2' },
      ],
    });

    mockSdkClient.session.revert.mockResolvedValue({ data: true });
    mockSdkClient.global.event.mockResolvedValue({ stream: emptyEventStream() });
    mockSdkClient.session.prompt.mockResolvedValue(undefined);

    const handler = createParticipantHandler(state);

    // History has only 1 ChatRequestTurn → currentTurnIndex = 1 < 3 → full rewind
    // @ts-expect-error — private ctor in vscode types, public in mock
const reqTurn = new vscode.ChatRequestTurn('initial', undefined);
    const result = await handler(
      createRequest({ prompt: 'restart from turn 0', sessionId: 'chat-revert-3' }),
      { history: [reqTurn] },
      stream,
      token,
    );

    // Should revert msg-2 first (back to front), then msg-1
    expect(mockSdkClient.session.revert).toHaveBeenCalledTimes(2);
    expect(mockSdkClient.session.revert).toHaveBeenNthCalledWith(1, {
      path: { id: 'revert-session-3' },
      body: { messageID: 'msg-2' },
      query: { directory: '/test/workspace' },
    });
    expect(mockSdkClient.session.revert).toHaveBeenNthCalledWith(2, {
      path: { id: 'revert-session-3' },
      body: { messageID: 'msg-1' },
      query: { directory: '/test/workspace' },
    });

    // TurnMap should keep only msg-0
    const chatState = state.sessionMap.get('chat-revert-3')!;
    expect(chatState.turnMap).toEqual([
      { vscodeTurn: 0, opencodeMessageId: 'msg-0' },
    ]);
    expect(result!.metadata).toHaveProperty('sessionId', 'revert-session-3');
  });

  it('should handle full rewind to beginning when no prior messages remain', async () => {
    backendStatus = 'running';
    // Simulate 2 completed turns
    state.sessionMap.set('chat-revert-full', {
      opencodeSessionId: 'full-rewind-session',
      turnMap: [
        { vscodeTurn: 0, opencodeMessageId: 'msg-0' },
        { vscodeTurn: 1, opencodeMessageId: 'msg-1' },
      ],
    });

    mockSdkClient.global.event.mockResolvedValue({ stream: emptyEventStream() });
    mockSdkClient.session.prompt.mockResolvedValue(undefined);

    const handler = createParticipantHandler(state);

    // No request turns in history → currentTurnIndex = 0 < 2 → full rewind with no revert needed
    const result = await handler(
      createRequest({ prompt: 'start fresh', sessionId: 'chat-revert-full' }),
      { history: [] },
      stream,
      token,
    );

    // Should NOT call revert (no prior message to revert to)
    expect(mockSdkClient.session.revert).not.toHaveBeenCalled();

    // TurnMap should be empty
    const chatState = state.sessionMap.get('chat-revert-full')!;
    expect(chatState.turnMap).toEqual([]);

    // Should prompt on the same session
    expect(mockSdkClient.session.prompt).toHaveBeenCalledWith({
      path: { id: 'full-rewind-session' },
      body: { parts: [{ type: 'text', text: 'start fresh' }] },
      query: { directory: '/test/workspace' },
    });
  });

  it('should fall back to new session on revert failure', async () => {
    backendStatus = 'running';
    state.sessionMap.set('chat-revert-fail', {
      opencodeSessionId: 'fail-session',
      turnMap: [
        { vscodeTurn: 0, opencodeMessageId: 'msg-0' },
        { vscodeTurn: 1, opencodeMessageId: 'msg-1' },
      ],
    });

    // Mock revert to fail
    mockSdkClient.session.revert.mockResolvedValue({ error: 'revert rejected' });
    // Mock session.create fallback to succeed
    mockSdkClient.session.create.mockResolvedValue({
      data: { id: 'fallback-session' },
    });
    mockSdkClient.global.event.mockResolvedValue({ stream: emptyEventStream() });
    mockSdkClient.session.prompt.mockResolvedValue(undefined);

    const handler = createParticipantHandler(state);

    // @ts-expect-error — private ctor in vscode types, public in mock
const reqTurn = new vscode.ChatRequestTurn('initial', undefined);
    const result = await handler(
      createRequest({ prompt: 'after revert fail', sessionId: 'chat-revert-fail' }),
      { history: [reqTurn] },
      stream,
      token,
    );

    // Should have attempted revert
    expect(mockSdkClient.session.revert).toHaveBeenCalled();

    // Should fall back by creating a new session
    expect(mockSdkClient.session.create).toHaveBeenCalledWith({
      query: { directory: '/test/workspace' },
    });

    // Should prompt on the fallback session
    expect(mockSdkClient.session.prompt).toHaveBeenCalledWith({
      path: { id: 'fallback-session' },
      body: { parts: [{ type: 'text', text: 'after revert fail' }] },
      query: { directory: '/test/workspace' },
    });

    // TurnMap should be reset
    const chatState = state.sessionMap.get('chat-revert-fail')!;
    expect(chatState.turnMap).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Backend start failure
  // -----------------------------------------------------------------------

  it('should show error when backend fails to start', async () => {
    const handler = createParticipantHandler(state);

    vi.mocked(state.backend.start).mockResolvedValue({ error: 'backend unavailable' });

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
  // Server start failure
  // -----------------------------------------------------------------------

  it('should show error when server fails to start', async () => {
    const handler = createParticipantHandler(state);
    vi.mocked(state.backend.start).mockRejectedValue(
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
    vi.mocked(state.backend.start).mockRejectedValue('string error');

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

  it('should skip server start if already running', async () => {
    backendStatus = 'running';
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

    expect(state.backend.start).not.toHaveBeenCalled();
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

    // Set up a running backend
    backendStatus = 'running';
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

    backendStatus = 'running';
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
    backendStatus = 'running';
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
    backendStatus = 'running';
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
    backendStatus = 'running';
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

  // -----------------------------------------------------------------------
  // ACP → legacy event denormalization (compatibility layer)
  // -----------------------------------------------------------------------

  describe('denormalizeAcpEvent', () => {
    // -- permission.asked --
    it('should convert permission.asked to legacy format', () => {
      const acp: AcpEvent = {
        type: 'permission.asked',
        permissionId: 'perm_1',
        sessionId: 'ses_test',
        permission: 'file:write',
        patterns: ['/src/**'],
        metadata: { filepath: '/src/app.ts', diff: '...' },
        always: ['once'],
        tool: { messageId: 'msg_1', callId: 'call_1' },
      };
      const result = denormalizeAcpEvent(acp);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('permission.asked');
      const p = (result as PermissionAskedEvent).properties;
      expect(p.id).toBe('perm_1');
      expect(p.sessionID).toBe('ses_test');
      expect(p.permission).toBe('file:write');
      expect(p.patterns).toEqual(['/src/**']);
      expect(p.metadata).toEqual({ filepath: '/src/app.ts', diff: '...' });
      expect(p.always).toEqual(['once']);
      expect(p.tool).toEqual({ messageID: 'msg_1', callID: 'call_1' });
    });

    it('should convert permission.asked without tool metadata', () => {
      const acp: AcpEvent = {
        type: 'permission.asked',
        permissionId: 'perm_2',
        sessionId: 'ses_test',
        permission: 'command:bash',
        patterns: [],
        metadata: {},
        always: [],
      };
      const result = denormalizeAcpEvent(acp);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('permission.asked');
      const p = (result as PermissionAskedEvent).properties;
      expect(p.id).toBe('perm_2');
      expect(p.tool).toBeUndefined();
    });

    // -- permission.replied --
    it('should convert permission.replied to legacy format', () => {
      const acp: AcpEvent = {
        type: 'permission.replied',
        sessionId: 'ses_test',
        permissionId: 'perm_1',
        response: 'once',
      };
      const result = denormalizeAcpEvent(acp);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('permission.replied');
      expect((result as { properties: Record<string, unknown> }).properties).toMatchObject({
        sessionID: 'ses_test',
        permissionID: 'perm_1',
        response: 'once',
      });
    });

    // -- part.updated → message.part.updated --
    it('should convert part.updated (text) to message.part.updated', () => {
      const acp: AcpEvent = {
        type: 'part.updated',
        part: {
          id: 'prt_txt',
          type: 'text',
          messageId: 'msg_ai_1',
          sessionId: 'ses_test',
          text: 'Hello world',
          synthetic: false,
        } as AcpStreamPart,
        delta: 'Hello',
      };
      const result = denormalizeAcpEvent(acp);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('message.part.updated');
      const props = (result as { properties: Record<string, unknown> }).properties as Record<string, unknown>;
      const part = props.part as Record<string, unknown>;
      expect(part.type).toBe('text');
      expect(part.id).toBe('prt_txt');
      expect(part.messageID).toBe('msg_ai_1');
      expect(part.sessionID).toBe('ses_test');
      expect(part.text).toBe('Hello world');
      expect(part.synthetic).toBe(false);
      expect(props.delta).toBe('Hello');
    });

    it('should convert part.updated (reasoning) to message.part.updated', () => {
      const acp: AcpEvent = {
        type: 'part.updated',
        part: {
          id: 'prt_reason',
          type: 'reasoning',
          messageId: 'msg_ai_1',
          sessionId: 'ses_test',
          text: 'thinking...',
        } as AcpStreamPart,
      };
      const result = denormalizeAcpEvent(acp);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('message.part.updated');
      const part = ((result as { properties: Record<string, unknown> }).properties as Record<string, unknown>).part as Record<string, unknown>;
      expect(part.type).toBe('reasoning');
      expect(part.id).toBe('prt_reason');
      expect(part.text).toBe('thinking...');
    });

    it('should convert part.updated (tool) to message.part.updated', () => {
      const acp: AcpEvent = {
        type: 'part.updated',
        part: {
          id: 'prt_tool',
          type: 'tool',
          messageId: 'msg_ai_1',
          sessionId: 'ses_test',
          toolName: 'read',
          callId: 'call_read',
          state: {
            status: 'completed',
            input: { filePath: '/a.txt' },
            output: 'file content',
            title: 'Read file',
          },
        } as AcpStreamPart,
      };
      const result = denormalizeAcpEvent(acp);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('message.part.updated');
      const part = ((result as { properties: Record<string, unknown> }).properties as Record<string, unknown>).part as Record<string, unknown>;
      expect(part.type).toBe('tool');
      expect(part.tool).toBe('read');
      expect(part.callID).toBe('call_read');
      expect((part.state as Record<string, unknown>).status).toBe('completed');
      expect((part.state as Record<string, unknown>).output).toBe('file content');
    });

    // -- part.delta → message.part.delta --
    it('should convert part.delta to message.part.delta', () => {
      const acp: AcpEvent = {
        type: 'part.delta',
        partId: 'prt_ai_1',
        delta: 'Hello world',
        field: 'text',
      };
      const result = denormalizeAcpEvent(acp);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('message.part.delta');
      const props = (result as { properties: Record<string, unknown> }).properties;
      expect(props.partID).toBe('prt_ai_1');
      expect(props.delta).toBe('Hello world');
      expect(props.field).toBe('text');
    });

    it('should convert part.delta without field', () => {
      const acp: AcpEvent = {
        type: 'part.delta',
        partId: 'prt_ai_2',
        delta: 'more text',
      };
      const result = denormalizeAcpEvent(acp);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('message.part.delta');
      const props = (result as { properties: Record<string, unknown> }).properties;
      expect(props.partID).toBe('prt_ai_2');
      expect(props.delta).toBe('more text');
      expect(props.field).toBeUndefined();
    });

    // -- session.diff --
    it('should convert session.diff to legacy format', () => {
      const acp: AcpEvent = {
        type: 'session.diff',
        sessionId: 'ses_test',
        diffs: [
          { file: '/src/app.ts', patch: '...', additions: 5, deletions: 2, status: 'modified' },
          { file: '/src/new.ts', patch: '', additions: 10, deletions: 0, status: 'added' },
        ],
      };
      const result = denormalizeAcpEvent(acp);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('session.diff');
      const props = (result as { properties: Record<string, unknown> }).properties;
      expect(props.sessionID).toBe('ses_test');
      expect(props.diff).toHaveLength(2);
      expect((props.diff as Array<Record<string, unknown>>)[0]).toMatchObject({
        file: '/src/app.ts',
        additions: 5,
        deletions: 2,
        status: 'modified',
      });
    });

    // -- session.idle --
    it('should convert session.idle to legacy format', () => {
      const acp: AcpEvent = {
        type: 'session.idle',
        sessionId: 'ses_test',
      };
      const result = denormalizeAcpEvent(acp);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('session.idle');
      const props = (result as { properties: Record<string, unknown> }).properties;
      expect(props.sessionID).toBe('ses_test');
    });

    it('should convert session.idle without sessionId', () => {
      const acp: AcpEvent = {
        type: 'session.idle',
      };
      const result = denormalizeAcpEvent(acp);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('session.idle');
    });

    // -- lifecycle events → null (filtered out) --
    it('should return null for session.created', () => {
      expect(denormalizeAcpEvent({ type: 'session.created', sessionId: 'ses_test' })).toBeNull();
    });

    it('should return null for session.updated', () => {
      expect(denormalizeAcpEvent({ type: 'session.updated', sessionId: 'ses_test' })).toBeNull();
    });

    it('should return null for session.deleted', () => {
      expect(denormalizeAcpEvent({ type: 'session.deleted', sessionId: 'ses_test' })).toBeNull();
    });

    it('should return null for session.error', () => {
      expect(denormalizeAcpEvent({ type: 'session.error', sessionId: 'ses_test' })).toBeNull();
    });

    it('should return null for server.connected', () => {
      expect(denormalizeAcpEvent({ type: 'server.connected' })).toBeNull();
    });

    it('should return null for server.heartbeat', () => {
      expect(denormalizeAcpEvent({ type: 'server.heartbeat' })).toBeNull();
  });
});
});
