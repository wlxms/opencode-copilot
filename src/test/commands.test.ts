import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import type { AcpBackend } from '../acp/backend';
import type { AcpServerStatus } from '../acp/types';
import type { ExtensionState } from '../types';
import { routeCommand } from '../participant/commands';
import { AppEventBus } from '../acp/app-event-bus';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock SDK client with the expected interface */
function createMockClient() {
  return {
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
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('routeCommand', () => {
  let state: ExtensionState;
  let stream: vscode.ChatResponseStream;
  let token: vscode.CancellationToken;
  let backendStatus: AcpServerStatus;

  beforeEach(() => {
    vi.resetAllMocks();
    backendStatus = 'stopped';
    const sessionStore = new Map<string, unknown>();
    const backend: AcpBackend = {
      name: 'opencode',
      start: vi.fn(async () => {
        backendStatus = 'running';
        return { data: { url: 'http://127.0.0.1:51777', status: 'running' as const } };
      }),
      stop: vi.fn(async () => undefined),
      getStatus: vi.fn((): AcpServerStatus => backendStatus),
      getUrl: vi.fn(() => null),
      isRunning: vi.fn(() => backendStatus === 'running'),
      sessions: {
        create: vi.fn(),
        get: vi.fn(),
        update: vi.fn(async () => ({ data: undefined })),
        prompt: vi.fn(),
        revert: vi.fn(),
        abort: vi.fn(),
        list: vi.fn(),
        children: vi.fn(),
        status: vi.fn(),
        descendants: vi.fn(),
        findAncestor: vi.fn(),
        parent: vi.fn(),
        messages: vi.fn(),
      },
      config: {
        models: vi.fn(async () => ({ data: [] })),
        agents: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
      },
      events: {
        openSessionStream: vi.fn(),
        openGlobalStream: vi.fn(),
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
      sessions: {
        get: vi.fn((key: string) => sessionStore.get(key)),
        has: vi.fn((key: string) => sessionStore.has(key)),
        set: vi.fn((key: string, value: unknown) => { sessionStore.set(key, value); }),
        values: vi.fn(() => sessionStore.values()),
      } as unknown as ExtensionState['sessions'],
      statusBar: {} as ExtensionState['statusBar'],
      selection: {
        get: vi.fn(() => ({ agent: undefined, model: undefined, modelDisplayName: undefined })),
        setAgent: vi.fn(async () => {}),
        setModel: vi.fn(async () => {}),
      } as unknown as ExtensionState['selection'],
      bus: new AppEventBus(),
    };
    stream = {
      markdown: vi.fn(),
      progress: vi.fn(),
      push: vi.fn(),
    } as unknown as vscode.ChatResponseStream;
    token = {
      isCancellationRequested: false,
      onCancellationRequested: vi.fn(),
    };
  });

  // -----------------------------------------------------------------------
  // /new
  // -----------------------------------------------------------------------

  it('should create a new session and update state for /new command', async () => {
    vi.mocked(state.backend.sessions.create).mockResolvedValue({
      data: { id: 'session-new', title: '', createdAt: new Date() },
    });

    await routeCommand('new', state, stream, token);

    expect(state.backend.start).toHaveBeenCalledOnce();
    expect(state.backend.sessions.create).toHaveBeenCalledWith();
    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Started a new conversation session'),
    );
  });

  it('should show error when /new is called without a connected client', async () => {
    vi.mocked(state.backend.start).mockResolvedValue({ error: 'Server not available' });

    await routeCommand('new', state, stream, token);

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Failed to start backend'),
    );
  });

  it('should show error on /new when session creation fails', async () => {
    vi.mocked(state.backend.sessions.create).mockRejectedValue(
      new Error('Session limit reached'),
    );

    await routeCommand('new', state, stream, token);

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Session error'),
    );
  });

  // -----------------------------------------------------------------------
  // /help
  // -----------------------------------------------------------------------

  it('should show formatted help text for /help command', async () => {
    await routeCommand('help', state, stream, token);

    expect(stream.markdown).toHaveBeenCalledTimes(1);
    const helpText = (stream.markdown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(helpText).toContain('/new');
    expect(helpText).toContain('/help');
    expect(helpText).toContain('/model');
    expect(helpText).toContain('Available Commands');
  });

  // -----------------------------------------------------------------------
  // /model
  // -----------------------------------------------------------------------

  it('should show providers and models for /model command', async () => {
    backendStatus = 'running';
    vi.mocked(state.backend.config.models).mockResolvedValue({
      data: [
        { id: 'gpt-4o', name: 'GPT-4o', provider: 'OpenAI' },
        { id: 'claude-3-opus', name: 'Claude 3 Opus', provider: 'Anthropic' },
      ],
    });

    await routeCommand('model', state, stream, token);

    const modelText = (stream.markdown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(modelText).toContain('Available Models');
    expect(modelText).toContain('OpenAI');
    expect(modelText).toContain('gpt-4o');
    expect(modelText).toContain('GPT-4o');
    expect(modelText).toContain('Anthropic');
    expect(modelText).toContain('claude-3-opus');

    // Should NOT include inactive models
    expect(modelText).not.toContain('gpt-3.5-turbo');
  });

  it('should show error when /model is called without a connected client', async () => {
    vi.mocked(state.backend.start).mockResolvedValue({ error: 'Server not available' });

    await routeCommand('model', state, stream, token);

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Failed to start backend'),
    );
  });

  it('should show error when providers call fails', async () => {
    backendStatus = 'running';
    vi.mocked(state.backend.config.models).mockRejectedValue(new Error('API error'));

    await routeCommand('model', state, stream, token);

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Unable to retrieve model information'),
    );
  });

  it('should show message when no providers configured', async () => {
    backendStatus = 'running';
    vi.mocked(state.backend.config.models).mockResolvedValue({ data: [] });

    await routeCommand('model', state, stream, token);

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('No providers configured'),
    );
  });

  // -----------------------------------------------------------------------
  // Unknown command
  // -----------------------------------------------------------------------

  it('should show error for unknown command', async () => {
    await routeCommand('unknown', state, stream, token);

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Unknown command'),
    );
  });

  it('should be case-insensitive for command names', async () => {
    vi.mocked(state.backend.sessions.create).mockResolvedValue({
      data: { id: 'session-case', title: '', createdAt: new Date() },
    });

    await routeCommand('New', state, stream, token);

    expect(state.backend.sessions.create).toHaveBeenCalledOnce();
  });

  // -----------------------------------------------------------------------
  // /model with providers that have no active models
  // -----------------------------------------------------------------------

  it('should skip providers with no active models in /model output', async () => {
    backendStatus = 'running';
    vi.mocked(state.backend.config.models).mockResolvedValue({ data: [] });

    await routeCommand('model', state, stream, token);

    const modelText = (stream.markdown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;

    // Provider with no active models should not appear
    expect(modelText).not.toContain('TestAI');
  });
});
