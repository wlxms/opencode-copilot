/**
 * OpenCode backend adapter — concrete AcpBackend implementation.
 *
 * Maps every ACP operation to the OpenCode SDK, reusing
 * OpenCodeServerManager for lifecycle and GlobalEventBroker
 * for event multiplexing. No VSCode imports.
 */

import { OpenCodeServerManager } from '../../opencode/server';
import { GlobalEventBroker } from './event-broker';
import type {
  AcpBackend,
  AcpSessionOperations,
  AcpConfigOperations,
  AcpEventOperations,
  AcpPermissionOperations,
  AcpEventStream,
} from '../../acp/backend';
import type {
  AcpServerInfo,
  AcpServerStatus,
  AcpSessionInfo,
  AcpModel,
  AcpAgent,
  AcpConfig,
  AcpResult,
  AcpPermissionResponse,
  AcpEvent,
} from '../../acp/types';
import { normalizeStreamEvent } from './events';
import type { OpenCodeEventStream } from './sdk-events';

// ===========================================================================
// AcpEventStream implementation wrapping OpenCodeEventStream
// ===========================================================================

class NormalizingEventStream implements AcpEventStream {
  constructor(private readonly inner: OpenCodeEventStream) {}

  readonly stream: AsyncIterable<AcpEvent> = {
    [Symbol.asyncIterator]: (): AsyncIterator<AcpEvent> => {
      const innerIter = this.inner.stream[Symbol.asyncIterator]();
      let buffer: AcpEvent[] = [];

      const next = async (): Promise<IteratorResult<AcpEvent>> => {
        while (buffer.length > 0) {
          const ev = buffer.shift()!;
          return { value: ev, done: false };
        }

        const result = await innerIter.next();
        if (result.done) {
          return { value: undefined, done: true };
        }

        buffer = normalizeStreamEvent(result.value);
        return next();
      };

      return { next };
    },
  };
}

// ===========================================================================
// Helpers
// ===========================================================================

function toAcpSessionInfo(data: { id?: string; title?: string; time?: { created?: number } }): AcpSessionInfo {
  return {
    id: data.id ?? '',
    title: data.title ?? '',
    createdAt: new Date(data.time?.created ?? Date.now()),
  };
}

function extractErrorMessage(value: unknown, fallback: string): string {
  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.message === 'string') {
      return record.message;
    }
    if (typeof record.code === 'string') {
      return record.code;
    }
  }

  return fallback;
}

function getResultError(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  return (value as Record<string, unknown>).error;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ===========================================================================
// Shape of the SDK client that we consume.
// Stops short of importing OpenCodeClient from types/index.ts.
// ===========================================================================

interface ClientSessionOps {
  create(opts: { body?: Record<string, unknown>; query?: { directory?: string } }): Promise<{ data?: { id?: string; title?: string; time?: { created?: number } } }>;
  get(opts: { path: { id: string }; query?: { directory?: string } }): Promise<{ data?: { id?: string; title?: string; time?: { created?: number } } }>;
  prompt(opts: { path: { id: string }; body: { parts: Array<{ type: 'text'; text: string }> }; query?: { directory?: string } }): Promise<unknown>;
  revert(opts: { path: { id: string }; body: { messageID: string; partID?: string }; query?: { directory?: string } }): Promise<unknown>;
  abort(opts: { path: { id: string }; query?: { directory?: string } }): Promise<{ data?: boolean }>;
  list(opts: { query?: { directory?: string } }): Promise<{ data?: Array<{ id?: string; title?: string; time?: { created?: number } }> }>;
}

interface ClientConfigOps {
  providers(opts: { query?: { directory?: string } }): Promise<{
    data?: { providers?: Array<{ id: string; name: string; models?: Array<{ id: string; name?: string; providerID?: string; capabilities?: Record<string, unknown> }> }> };
  }>;
}

interface ClientEventOps {
  subscribe(): Promise<OpenCodeEventStream>;
}

interface ClientGlobalOps {
  event(): Promise<OpenCodeEventStream>;
}

interface ClientPermissionOps {
  postSessionIdPermissionsPermissionId(opts: {
    path: { id: string; permissionID: string };
    body?: { response: string };
    query?: { directory?: string };
  }): Promise<unknown>;
}

interface SdkClient {
  session: ClientSessionOps;
  config: ClientConfigOps;
  event: ClientEventOps;
  global: ClientGlobalOps;
  postSessionIdPermissionsPermissionId: ClientPermissionOps['postSessionIdPermissionsPermissionId'];
}

// ===========================================================================
// Adapter
// ===========================================================================

export class OpenCodeBackend implements AcpBackend {
  readonly name = 'opencode';

  private readonly serverManager = new OpenCodeServerManager();
  private readonly eventBroker = new GlobalEventBroker();
  private rawClient: unknown = null;

  // =======================================================================
  // Lifecycle
  // =======================================================================

  async start(directory?: string): Promise<AcpResult<AcpServerInfo>> {
    try {
      const url = await this.serverManager.start(directory);
      const rawClient = this.serverManager.getClient();
      if (!rawClient) {
        return { error: 'OpenCode client not available after start' };
      }
      this.rawClient = rawClient;
      return {
        data: {
          url,
          status: 'running',
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  }

  async stop(): Promise<void> {
    this.rawClient = null;
    await this.serverManager.stop();
  }

  getStatus(): AcpServerStatus {
    return this.serverManager.getStatus();
  }

  getUrl(): string | null {
    return this.serverManager.getUrl();
  }

  isRunning(): boolean {
    return this.serverManager.isRunning();
  }

  // =======================================================================
  // Internal: typed reference to the SDK client
  // =======================================================================

  private get sdk(): SdkClient {
    const c = this.serverManager.getClient();
    if (!c) throw new Error('Server not running');
    return c as unknown as SdkClient;
  }

  // =======================================================================
  // Sessions
  // =======================================================================

  readonly sessions: AcpSessionOperations = {
    create: async (options?): Promise<AcpResult<AcpSessionInfo>> => {
      try {
        const result = await this.sdk.session.create({
          body: options?.title ? { title: options.title } : undefined,
          query: options?.directory ? { directory: options.directory } : undefined,
        });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Session not created') };
        }
        if (!result.data?.id) {
          return { error: 'Session not created' };
        }
        return { data: toAcpSessionInfo(result.data) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    get: async (id: string, directory?: string): Promise<AcpResult<AcpSessionInfo>> => {
      try {
        const result = await this.sdk.session.get({
          path: { id },
          query: directory ? { directory } : undefined,
        });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Session not found') };
        }
        if (!result.data) {
          return { error: 'Session not found' };
        }
        return { data: toAcpSessionInfo(result.data) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    children: async (id: string, directory?: string) => {
      try {
        const result = await this.sdk.session.children({
          path: { id },
          query: directory ? { directory } : undefined,
        });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Failed to get children') };
        }
        return {
          data: (result.data ?? []).map(s => ({ id: s.id, parentID: s.parentID })),
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    status: async (directory?: string) => {
      try {
        const result = await this.sdk.session.status({
          query: directory ? { directory } : undefined,
        });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Failed to get session status') };
        }
        return { data: result.data ?? {} };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    prompt: async (
      id: string,
      text: string,
      directory?: string,
      options?: {
        model?: { providerID: string; modelID: string };
        agent?: string;
      },
    ): Promise<AcpResult<unknown>> => {
      try {
        const result = await this.sdk.session.prompt({
          path: { id },
          query: directory ? { directory } : undefined,
          body: {
            parts: [{ type: 'text', text }],
            model: options?.model,
            agent: options?.agent,
          },
        } as any);
        const error = getResultError(result);
        if (error !== undefined) {
          return {
            error: `${extractErrorMessage(error, 'Prompt failed')} | raw=${safeStringify(error)}`,
          };
        }
        return { data: result };
      } catch (err) {
        return {
          error: `${err instanceof Error ? err.message : String(err)} | raw=${safeStringify(err)}`,
        };
      }
    },

    revert: async (id: string, messageId: string, partId?: string, directory?: string): Promise<AcpResult<unknown>> => {
      try {
        const result = await this.sdk.session.revert({
          path: { id },
          body: { messageID: messageId, ...(partId ? { partID: partId } : {}) },
          query: directory ? { directory } : undefined,
        });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Revert failed') };
        }
        return { data: result };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    abort: async (id: string, directory?: string): Promise<AcpResult<boolean>> => {
      try {
        const result = await this.sdk.session.abort({
          path: { id },
          query: directory ? { directory } : undefined,
        });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Abort failed') };
        }
        return { data: result?.data ?? true };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    list: async (directory?: string): Promise<AcpResult<AcpSessionInfo[]>> => {
      try {
        const result = await this.sdk.session.list({
          query: directory ? { directory } : undefined,
        });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'List sessions failed') };
        }
        return { data: (result.data ?? []).map(toAcpSessionInfo) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  // =======================================================================
  // Config
  // =======================================================================

  readonly config: AcpConfigOperations = {
    models: async (directory?: string): Promise<AcpResult<AcpModel[]>> => {
      try {
        const result = await this.sdk.config.providers({
          query: directory ? { directory } : undefined,
        });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'List models failed') };
        }
        const providers = result.data?.providers ?? [];
        const models: AcpModel[] = [];
        for (const provider of providers) {
          for (const m of Object.values(provider.models ?? {})) {
            const capRecord = m.capabilities;
            models.push({
              id: m.id,
              name: m.name ?? m.id,
              provider: provider.id,
              providerName: provider.name,
              capabilities: capRecord
                ? Object.keys(capRecord).filter((k) => Boolean(capRecord[k]))
                : undefined,
            });
          }
        }
        return { data: models };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    agents: async (directory?: string): Promise<AcpResult<AcpAgent[]>> => {
      try {
        const rawClient = this.serverManager.getClient() as any;
        const result = await rawClient.app.agents({
          query: directory ? { directory } : undefined,
        });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'List agents failed') };
        }
        const agents: AcpAgent[] = (result.data ?? []).map((a: any) => ({
          id: a.id ?? a.name ?? '',
          name: a.name ?? a.id,
          description: a.description,
          model: a.model,
          mode: a.mode,
          hidden: a.hidden,
        }));
        return { data: agents };
      } catch (err) {
        return { error: extractErrorMessage(err, 'List agents failed') };
      }
    },

    get: async (directory?: string): Promise<AcpResult<AcpConfig>> => {
      try {
        const rawClient = this.serverManager.getClient() as any;
        const configResult = await rawClient.config.get({
          query: directory ? { directory } : undefined,
        });
        const error = getResultError(configResult);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Get config failed') };
        }
        const raw = configResult.data ?? {};
        const config: AcpConfig = {
          model: raw.model,
          small_model: raw.small_model,
          default_agent: raw.default_agent,
          disabled_providers: raw.disabled_providers,
          enabled_providers: raw.enabled_providers,
          agent: raw.agent,
          provider: raw.provider,
        };
        return { data: config };
      } catch (err) {
        return { error: extractErrorMessage(err, 'Get config failed') };
      }
    },

    update: async (config: Partial<AcpConfig>, directory?: string): Promise<AcpResult<void>> => {
      try {
        const rawClient = this.serverManager.getClient() as any;
        const result = await rawClient.config.update({
          query: directory ? { directory } : undefined,
          config,
        });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Update config failed') };
        }
        return { data: undefined };
      } catch (err) {
        return { error: extractErrorMessage(err, 'Update config failed') };
      }
    },
  };

  // =======================================================================
  // Events — delegates to GlobalEventBroker + normalisation
  // =======================================================================

  readonly events: AcpEventOperations = {
    openSessionStream: (sessionId: string): AcpEventStream => {
      const rawStream = this.eventBroker.openSessionStream(sessionId);
      return new NormalizingEventStream(rawStream);
    },

    openGlobalStream: async (): Promise<AcpEventStream> => {
      const rawStream = await this.sdk.global.event();
      return new NormalizingEventStream(rawStream);
    },

    closeSessionStream: (sessionId: string): void => {
      this.eventBroker.closeSessionStream(sessionId);
    },

    ensureStarted: async (): Promise<void> => {
      // Pass the raw SDK client — structurally compatible with
      // the OpenCodeClient interface consumed by GlobalEventBroker.
      const c = this.rawClient;
      if (c) {
        await this.eventBroker.ensureStarted(c as Parameters<GlobalEventBroker['ensureStarted']>[0]);
      }
    },
  };

  // =======================================================================
  // Session hierarchy — delegates to GlobalEventBroker
  // =======================================================================

  /**
   * Walk up the parent chain from `sessionId` and return the first session ID
   * that appears in `candidateIds`. Used by StreamBridge to route grandchild events.
   */
  findAncestorScope(sessionId: string, candidateIds: Set<string>): string | undefined {
    return this.eventBroker.findAncestorIn(sessionId, candidateIds);
  }

  /**
   * Get the parent session ID for a given session, or undefined.
   */
  getParentSession(sessionId: string): string | undefined {
    return this.eventBroker.getParentSession(sessionId);
  }

  /**
   * Get all descendant session IDs (children, grandchildren, etc.) of the given session.
   * Used for cascade-abort when the user cancels a parent session.
   */
  getDescendantSessions(parentId: string): string[] {
    return this.eventBroker.getDescendantSessions(parentId);
  }

  // =======================================================================
  // Permissions
  // =======================================================================

  readonly permissions: AcpPermissionOperations = {
    reply: async (
      sessionId: string,
      permissionId: string,
      response: AcpPermissionResponse,
      directory?: string,
    ): Promise<void> => {
      await this.sdk.postSessionIdPermissionsPermissionId({
        path: { id: sessionId, permissionID: permissionId },
        body: { response },
        query: directory ? { directory } : undefined,
      });
    },
  };
}
