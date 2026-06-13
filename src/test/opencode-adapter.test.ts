import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClient = {
  session: {
    create: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    prompt: vi.fn(),
    promptAsync: vi.fn(),
    revert: vi.fn(),
    abort: vi.fn(),
    list: vi.fn(),
    children: vi.fn(),
    status: vi.fn(),
    messages: vi.fn(),
  },
  global: {
    event: vi.fn(),
    config: {
      get: vi.fn(),
      update: vi.fn(),
    },
  },
  event: {
    subscribe: vi.fn(),
  },
  app: {
    agents: vi.fn(),
  },
  config: {
    providers: vi.fn(),
    get: vi.fn(),
  },
  permission: {
    reply: vi.fn(),
  },
  question: {
    reply: vi.fn(),
    reject: vi.fn(),
  },
};

const mockServerManager = {
  start: vi.fn(),
  stop: vi.fn(),
  getStatus: vi.fn(),
  getUrl: vi.fn(),
  isRunning: vi.fn(),
  getClient: vi.fn(),
};

vi.mock('../opencode/server', () => ({
  OpenCodeServerManager: vi.fn(function OpenCodeServerManager() {
    return mockServerManager;
  }),
}));

import { OpenCodeBackend } from '../backends/opencode/adapter';

describe('OpenCodeBackend', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockServerManager.start.mockResolvedValue('http://127.0.0.1:12345');
    mockServerManager.stop.mockResolvedValue(undefined);
    mockServerManager.getStatus.mockReturnValue('running');
    mockServerManager.getUrl.mockReturnValue('http://127.0.0.1:12345');
    mockServerManager.isRunning.mockReturnValue(true);
    mockServerManager.getClient.mockReturnValue(mockClient);
  });

  it('uses the async prompt route so streaming turns are accepted by OpenCode', async () => {
    const backend = new OpenCodeBackend();
    await backend.start('D:\\Temp');
    mockClient.session.prompt.mockResolvedValue({
      error: {
        name: 'UnknownError',
        data: {
          message: 'Unexpected server error. Check server logs for details.',
          ref: 'err_sync_route',
        },
      },
    });
    mockClient.session.promptAsync.mockResolvedValue({
      data: null,
      request: { timeout: false },
      response: {},
    });

    const result = await backend.sessions.prompt('ses_123', 'Say only: ok', 'D:\\Temp', {
      agent: 'build',
      model: { providerID: 'deepseek', modelID: 'deepseek-v4-flash' },
    });

    expect(result.error).toBeUndefined();
    expect(mockClient.session.prompt).not.toHaveBeenCalled();
    expect(mockClient.session.promptAsync).toHaveBeenCalledWith({
      sessionID: 'ses_123',
      directory: 'D:\\Temp',
      parts: [{ type: 'text', text: 'Say only: ok' }],
      agent: 'build',
      model: { providerID: 'deepseek', modelID: 'deepseek-v4-flash' },
    });
  });
});
