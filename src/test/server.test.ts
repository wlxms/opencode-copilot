import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the SDK before importing
// ---------------------------------------------------------------------------

const mockServer = {
  url: 'http://127.0.0.1:51777',
  close: vi.fn(),
};

const mockClient = {
  session: {
    create: vi.fn(),
    prompt: vi.fn(),
  },
  event: {
    subscribe: vi.fn(),
  },
  config: {
    providers: vi.fn(),
    update: vi.fn(),
  },
  postSessionIdPermissionsPermissionId: vi.fn(),
};

const mockInstance = {
  server: mockServer,
  client: mockClient,
};

vi.mock('@opencode-ai/sdk', () => ({
  createOpencode: vi.fn(),
}));

import { createOpencode } from '@opencode-ai/sdk';
import { OpenCodeServerManager } from '../opencode/server';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenCodeServerManager', () => {
  let manager: OpenCodeServerManager;

  beforeEach(() => {
    vi.resetAllMocks();
    manager = new OpenCodeServerManager();
  });

  // -----------------------------------------------------------------------
  // Initial state
  // -----------------------------------------------------------------------

  it('should be in stopped state initially', () => {
    expect(manager.getStatus()).toBe('stopped');
    expect(manager.isRunning()).toBe(false);
    expect(manager.getUrl()).toBeNull();
    expect(manager.getClient()).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Start – success
  // -----------------------------------------------------------------------

  it('should call createOpencode with port 0 and return URL', async () => {
    (createOpencode as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockInstance,
    );

    const url = await manager.start();

    expect(createOpencode).toHaveBeenCalledWith({ port: 0 });
    expect(url).toBe('http://127.0.0.1:51777');
    expect(manager.getStatus()).toBe('running');
    expect(manager.isRunning()).toBe(true);
    expect(manager.getUrl()).toBe(url);
  });

  it('should delete OPENCODE_SERVER_PASSWORD env var before starting', async () => {
    process.env.OPENCODE_SERVER_PASSWORD = 'should-be-deleted';
    (createOpencode as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockInstance,
    );

    await manager.start();

    expect(process.env.OPENCODE_SERVER_PASSWORD).toBeUndefined();
  });

  it('should return cached URL if already running', async () => {
    (createOpencode as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockInstance,
    );

    await manager.start();
    const url2 = await manager.start();

    expect(url2).toBe('http://127.0.0.1:51777');
    expect(createOpencode).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // getClient
  // -----------------------------------------------------------------------

  it('should return the SDK client from getClient', async () => {
    (createOpencode as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockInstance,
    );

    await manager.start();
    const client = manager.getClient();

    expect(client).toBe(mockClient);
  });

  it('should return null from getClient when not running', () => {
    expect(manager.getClient()).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Stop
  // -----------------------------------------------------------------------

  it('should call server.close on stop', async () => {
    (createOpencode as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockInstance,
    );

    await manager.start();
    await manager.stop();

    expect(mockServer.close).toHaveBeenCalledTimes(1);
    expect(manager.getStatus()).toBe('stopped');
    expect(manager.isRunning()).toBe(false);
    expect(manager.getUrl()).toBeNull();
    expect(manager.getClient()).toBeNull();
  });

  it('should be safe to call stop when not running', async () => {
    await manager.stop();
    expect(manager.getStatus()).toBe('stopped');
  });

  // -----------------------------------------------------------------------
  // Start – error handling
  // -----------------------------------------------------------------------

  it('should throw OpenCode CLI not found on ENOENT error', async () => {
    const err = new Error('spawn ENOENT');
    (createOpencode as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      err,
    );

    await expect(manager.start()).rejects.toThrow('OpenCode CLI not found');
    expect(manager.getStatus()).toBe('error');
  });

  it('should throw OpenCode CLI not found on "not found" error', async () => {
    const err = new Error('command not found: opencode');
    (createOpencode as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      err,
    );

    await expect(manager.start()).rejects.toThrow('OpenCode CLI not found');
    expect(manager.getStatus()).toBe('error');
  });

  it('should throw generic error for other failures', async () => {
    const err = new Error('Port already in use');
    (createOpencode as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      err,
    );

    await expect(manager.start()).rejects.toThrow(
      'Failed to start OpenCode server: Port already in use',
    );
    expect(manager.getStatus()).toBe('error');
  });

  it('should handle non-Error rejection values', async () => {
    (createOpencode as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      'string error',
    );

    await expect(manager.start()).rejects.toThrow(
      'Failed to start OpenCode server: string error',
    );
    expect(manager.getStatus()).toBe('error');
  });
});
