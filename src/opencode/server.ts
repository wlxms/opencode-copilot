import { createOpencode } from '@opencode-ai/sdk';

export type ServerStatus = 'stopped' | 'starting' | 'running' | 'error';

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
export class OpenCodeServerManager {
  private instance: { server: { url: string; close: () => void }; client: any } | null = null;
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
      // Temporarily switch CWD so cross-spawn inherits the workspace path
      if (cwd) {
        process.chdir(cwd);
      }

      // DO NOT set OPENCODE_SERVER_PASSWORD — it causes 401 Unauthorized
      delete process.env.OPENCODE_SERVER_PASSWORD;

      this.instance = await createOpencode({
        port: 0,
      });
      this.serverUrl = this.instance.server.url;
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
  getClient(): any | null {
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
