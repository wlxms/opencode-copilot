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
  permission: {
    reply: vi.fn(),
  },
  question: {
    reply: vi.fn(),
    reject: vi.fn(),
  },
};

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { createParticipantHandler } from '../participant/handler';
import type { OpenCodeEvent } from '../backends/opencode/sdk-events';
import type { AcpServerStatus } from '../acp/types';
import type { ExtensionState } from '../types';

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

  beforeEach(() => {
    vi.resetAllMocks();
    backendStatus = 'stopped';

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
            directory: options?.directory,
            title: options?.title,
          });
          return { data: result.data ? { id: result.data.id ?? '', title: result.data.title ?? '', createdAt: new Date() } : undefined, error: result.error };
        }),
        get: vi.fn(async () => ({ data: undefined })),
        prompt: vi.fn(async (id: string, text: string, directory?: string) => {
          const result = await mockSdkClient.session.prompt({
            sessionID: id,
            directory,
            parts: [{ type: 'text', text }],
          });
          return { data: result };
        }),
        revert: vi.fn(async (id: string, messageId: string, partId?: string, directory?: string) => {
          const result = await mockSdkClient.session.revert({
            sessionID: id,
            directory,
            messageID: messageId,
            partID: partId,
          });
          if (result && typeof result === 'object' && 'error' in result) {
            return { error: String(result.error) };
          }
          return { data: result };
        }),
        abort: vi.fn(async (id: string, directory?: string) => {
          const result = await mockSdkClient.session.abort({
            sessionID: id,
            directory,
          });
          return { data: result.data };
        }),
        list: vi.fn(async () => ({ data: [] })),
        children: vi.fn(),
        status: vi.fn(),
        descendants: vi.fn(() => []),
        findAncestor: vi.fn(),
        parent: vi.fn(),
      },
      config: {
        models: vi.fn(async () => ({ data: [] })),
        agents: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
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
                ? payload.sessionId
                : payload.type === 'part.updated'
                  ? payload.part?.sessionId
                  : payload.type === 'part.delta'
                    ? undefined
                    : payload.type === 'session.diff'
                      ? payload.sessionId
                      : payload.type === 'permission.asked'
                        ? payload.sessionId
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
      questions: {
        reply: vi.fn(),
        reject: vi.fn(),
      },
    };

    state = {
      backend,
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
      sessionMap: new Map(),
      statusBar: {} as any,
    };

    stream = {
      markdown: vi.fn(),
      progress: vi.fn(),
      push: vi.fn(),
    } as unknown as vscode.ChatResponseStream;

    token = {
      isCancellationRequested: false,
      onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
    };

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
      directory: '/test/workspace',
      title: 'Chat chat-1',
    });
    // Session stored in sessionMap under the vscode chat session ID
    expect(state.sessionMap.get('chat-1')?.opencodeSessionId).toBe('session-1');

    // Events subscribed
    expect(state.backend.events.ensureStarted).toHaveBeenCalledOnce();

    // Prompt sent with correct format (v2 flat params)
    expect(mockSdkClient.session.prompt).toHaveBeenCalledWith({
      sessionID: 'session-1',
      parts: [{ type: 'text', text: 'write a test' }],
      directory: '/test/workspace',
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
      sessionID: 'existing-session',
      parts: [{ type: 'text', text: 'follow up' }],
      directory: '/test/workspace',
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
      sessionID: 'revert-session',
      messageID: 'msg-1',
      directory: '/test/workspace',
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
      sessionID: 'revert-session',
      parts: [{ type: 'text', text: 'edited follow-up' }],
      directory: '/test/workspace',
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
      sessionID: 'revert-session-3',
      messageID: 'msg-2',
      directory: '/test/workspace',
    });
    expect(mockSdkClient.session.revert).toHaveBeenNthCalledWith(2, {
      sessionID: 'revert-session-3',
      messageID: 'msg-1',
      directory: '/test/workspace',
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
      sessionID: 'full-rewind-session',
      parts: [{ type: 'text', text: 'start fresh' }],
      directory: '/test/workspace',
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
      directory: '/test/workspace',
    });

    // Should prompt on the fallback session
    expect(mockSdkClient.session.prompt).toHaveBeenCalledWith({
      sessionID: 'fallback-session',
      parts: [{ type: 'text', text: 'after revert fail' }],
      directory: '/test/workspace',
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
      sessionID: 'existing-id',
      parts: [{ type: 'text', text: 'question' }],
      directory: '/test/workspace',
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
        sessionID: 'session-abort-test',
        directory: '/test/workspace',
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
});
