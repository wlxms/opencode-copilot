import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import type { ExtensionState } from '../types';
import { routeCommand } from '../participant/commands';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock SDK client with the expected interface */
function createMockClient() {
  return {
    session: {
      create: vi.fn(),
      prompt: vi.fn(),
    },
    config: {
      providers: vi.fn(),
    },
    event: {
      subscribe: vi.fn(),
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

  beforeEach(() => {
    vi.resetAllMocks();
    state = {
      serverManager: {
        start: vi.fn().mockRejectedValue(new Error('Server not available')),
        getClient: vi.fn().mockReturnValue(null),
      },
      client: null,
      activeSessionId: null,
      serverStatus: 'stopped',
      turnMap: [],
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
      onCancellationRequested: vi.fn(),
    };
  });

  // -----------------------------------------------------------------------
  // /new
  // -----------------------------------------------------------------------

  it('should create a new session and update state for /new command', async () => {
    const mockClient = createMockClient();
    mockClient.session.create.mockResolvedValue({
      data: { id: 'session-new' },
    });
    state.client = mockClient;

    await routeCommand('new', state, stream, token);

    expect(mockClient.session.create).toHaveBeenCalledWith({ body: {} });
    expect(state.activeSessionId).toBe('session-new');
    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Started a new conversation session'),
    );
  });

  it('should show error when /new is called without a connected client', async () => {
    state.client = null;

    await routeCommand('new', state, stream, token);

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Failed to start OpenCode'),
    );
    expect(state.activeSessionId).toBeNull();
  });

  it('should show error on /new when session creation fails', async () => {
    const mockClient = createMockClient();
    mockClient.session.create.mockRejectedValue(
      new Error('Session limit reached'),
    );
    state.client = mockClient;

    await routeCommand('new', state, stream, token);

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Session error'),
    );
    expect(state.activeSessionId).toBeNull();
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
    const mockClient = createMockClient();
    mockClient.config.providers.mockResolvedValue({
      data: {
        providers: [
          {
            name: 'OpenAI',
            id: 'openai',
            models: {
              'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o', status: 'active' },
              'gpt-3.5': {
                id: 'gpt-3.5-turbo',
                name: 'GPT-3.5 Turbo',
                status: 'inactive',
              },
            },
          },
          {
            name: 'Anthropic',
            id: 'anthropic',
            models: {
              'claude-3': {
                id: 'claude-3-opus',
                name: 'Claude 3 Opus',
                status: 'active',
              },
            },
          },
        ],
      },
    });
    state.client = mockClient;

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
    state.client = null;

    await routeCommand('model', state, stream, token);

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Failed to start OpenCode'),
    );
  });

  it('should show error when providers call fails', async () => {
    const mockClient = createMockClient();
    mockClient.config.providers.mockRejectedValue(
      new Error('API error'),
    );
    state.client = mockClient;

    await routeCommand('model', state, stream, token);

    expect(stream.markdown).toHaveBeenCalledWith(
      expect.stringContaining('Unable to retrieve model information'),
    );
  });

  it('should show message when no providers configured', async () => {
    const mockClient = createMockClient();
    mockClient.config.providers.mockResolvedValue({
      data: { providers: [] },
    });
    state.client = mockClient;

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
    const mockClient = createMockClient();
    mockClient.session.create.mockResolvedValue({
      data: { id: 'session-case' },
    });
    state.client = mockClient;

    await routeCommand('New', state, stream, token);

    expect(mockClient.session.create).toHaveBeenCalledOnce();
    expect(state.activeSessionId).toBe('session-case');
  });

  // -----------------------------------------------------------------------
  // /model with providers that have no active models
  // -----------------------------------------------------------------------

  it('should skip providers with no active models in /model output', async () => {
    const mockClient = createMockClient();
    mockClient.config.providers.mockResolvedValue({
      data: {
        providers: [
          {
            name: 'TestAI',
            id: 'testai',
            models: {
              'test-model': {
                id: 'test-model',
                name: 'Test Model',
                status: 'inactive',
              },
            },
          },
        ],
      },
    });
    state.client = mockClient;

    await routeCommand('model', state, stream, token);

    const modelText = (stream.markdown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;

    // Provider with no active models should not appear
    expect(modelText).not.toContain('TestAI');
  });
});
