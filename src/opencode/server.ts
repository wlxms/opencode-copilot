import { createOpencode } from '@opencode-ai/sdk';
import { existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { OpenCodeClient, OpenCodeServerController } from '../types';

export type ServerStatus = 'stopped' | 'starting' | 'running' | 'error';

/** Default opencode.json config that enables permission.edit="ask" for externalEdit tracking */
const DEFAULT_OPENCODE_CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  permission: {
    edit: 'ask',
    bash: 'allow',
    read: 'allow',
  },
};

/**
 * Ensure an opencode.json exists in the given directory.
 * If the file already exists, it is NOT overwritten (user's config takes precedence).
 * If it doesn't exist, a default config with permission.edit="ask" is created.
 *
 * @returns true if a new file was created, false if one already existed
 */
function ensureOpencodeConfig(dir: string): boolean {
  const configPath = resolve(dir, 'opencode.json');
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(DEFAULT_OPENCODE_CONFIG, null, 2), 'utf-8');
    return true;
  }
  return false;
}

/**
 * Manages the lifecycle of the OpenCode server via the official SDK.
 *
 * Usage:
 *   const manager = new OpenCodeServerManager();
 *   const url = await manager.start();
 *   const client = manager.getClient();
 *   // ...
 *   await manager.stop();
 */
export class OpenCodeServerManager implements OpenCodeServerController {
  private instance: {
    server: { url: string; close: () => void };
    client: OpenCodeClient;
  } | null = null;
  private status: ServerStatus = 'stopped';
  private serverUrl: string | null = null;

  /**
   * Start the OpenCode server.
   * @param cwd - Working directory for the opencode server (project root).
   *              The server needs to spawn in the project context for proper
   *              initialization (auth, config, etc.).
   *              Additionally, query.directory is passed on each API call.
   */
  async start(cwd?: string): Promise<string> {
    if (this.status === 'running' && this.serverUrl) {
      return this.serverUrl;
    }

    this.status = 'starting';
    this.serverUrl = null;

    const originalCwd = process.cwd();
    try {
      // Ensure opencode.json exists in the project directory.
      // This is required for permission.edit="ask" to work, which enables
      // the per-edit externalEdit checkpoint mechanism.
      if (cwd) {
        ensureOpencodeConfig(cwd);
        process.chdir(cwd);
      }

      // DO NOT set OPENCODE_SERVER_PASSWORD — it causes 401 Unauthorized
      delete process.env.OPENCODE_SERVER_PASSWORD;

      const instance = await createOpencode({
        port: 0,
      });
      this.instance = {
        server: instance.server,
        client: instance.client,
      };
      this.serverUrl = instance.server.url;
      this.status = 'running';
      return this.serverUrl;
    } catch (err) {
      this.status = 'error';
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ENOENT') || msg.includes('not found')) {
        throw new Error(
          'OpenCode CLI not found. Install with: npm i -g opencode-ai',
        );
      }
      throw new Error(`Failed to start OpenCode server: ${msg}`);
    } finally {
      // Always restore original CWD
      if (cwd) {
        process.chdir(originalCwd);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.instance) {
      this.instance.server.close();
      this.instance = null;
      this.serverUrl = null;
      this.status = 'stopped';
    }
  }

  /** Get the SDK OpencodeClient instance, or null if not running */
  getClient(): OpenCodeClient | null {
    return this.instance?.client ?? null;
  }

  getStatus(): ServerStatus {
    return this.status;
  }

  isRunning(): boolean {
    return this.status === 'running';
  }

  getUrl(): string | null {
    return this.serverUrl;
  }
}
