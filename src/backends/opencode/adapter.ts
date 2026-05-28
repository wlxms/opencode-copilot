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
  AcpQuestionOperations,
  AcpEventStream,
} from '../../acp/backend';
import type {
  AcpServerInfo,
  AcpServerStatus,
  AcpSessionInfo,
  AcpSessionStatus,
  AcpModel,
  AcpAgent,
  AcpConfig,
  AcpResult,
  AcpPermissionResponse,
  AcpEvent,
  AcpMessageHistory,
  AcpHistoryMessage,
} from '../../acp/types';
import { normalizeStreamEvent } from './events';
import type { OpenCodeEventStream } from './sdk-events';
import type { OpenCodeClient, SdkAgentData } from '../../types';
import { OpenCodeSettingsProvider } from './settings';

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
// Adapter
// ===========================================================================

export class OpenCodeBackend implements AcpBackend {
  readonly name = 'opencode';

  private readonly serverManager = new OpenCodeServerManager();
  private readonly eventBroker = new GlobalEventBroker();
  private rawClient: OpenCodeClient | null = null;

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

  private get sdk(): OpenCodeClient {
    const c = this.serverManager.getClient();
    if (!c) {throw new Error('Server not running');}
    return c;
  }

  // =======================================================================
  // Sessions
  // =======================================================================

  readonly sessions: AcpSessionOperations = {
    create: async (options?): Promise<AcpResult<AcpSessionInfo>> => {
      try {
        const result = await this.sdk.session.create({
          directory: options?.directory,
          title: options?.title,
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
        const result = await this.sdk.session.get({ sessionID: id, directory });
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
        const result = await this.sdk.session.children({ sessionID: id, directory });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Failed to get children') };
        }
        return {
          data: (result.data ?? []).map(s => ({ id: s.id ?? '', parentID: s.parentID ?? '' })),
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    status: async (directory?: string) => {
      try {
        const result = await this.sdk.session.status({ directory });
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
          sessionID: id,
          directory,
          parts: [{ type: 'text', text }],
          model: options?.model,
          agent: options?.agent,
        });
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
          sessionID: id,
          directory,
          messageID: messageId,
          partID: partId,
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
        const result = await this.sdk.session.abort({ sessionID: id, directory });
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
        const result = await this.sdk.session.list({ directory });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'List sessions failed') };
        }
        return { data: (result.data ?? []).map(toAcpSessionInfo) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    // -- Hierarchy navigation (delegates to GlobalEventBroker) --

    descendants: (parentId: string): string[] => {
      return this.eventBroker.getDescendantSessions(parentId);
    },

    findAncestor: (sessionId: string, candidateIds: Set<string>): string | undefined => {
      return this.eventBroker.findAncestorIn(sessionId, candidateIds);
    },

    parent: (sessionId: string): string | undefined => {
      return this.eventBroker.getParentSession(sessionId);
    },

    messages: async (id: string, directory?: string): Promise<AcpResult<AcpMessageHistory>> => {
      try {
        const result = await this.sdk.session.messages({ sessionID: id, directory });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'Failed to get messages') };
        }

        const items = result.data ?? [];
        const mapped: AcpHistoryMessage[] = [];

        for (const item of items) {
          if (item.info.role === 'user') {
            // UserMessage: text is in the parts (type='text')
            const text = item.parts
              .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
              .map(p => p.text)
              .join('\n');
            mapped.push({
              id: item.info.id,
              role: 'user',
              text: text || '(no text)',
            });
          } else if (item.info.role === 'assistant') {
            // AssistantMessage: join text parts, collect tool call summaries
            const textParts: string[] = [];
            const toolCalls: Array<{ toolName: string; callId?: string }> = [];

            for (const part of item.parts) {
              if (part.type === 'text') {
                textParts.push((part as { type: 'text'; text: string }).text);
              } else if (part.type === 'tool') {
                const tp = part as { type: 'tool'; tool: string; callID?: string };
                toolCalls.push({ toolName: tp.tool, callId: tp.callID });
              }
            }

            mapped.push({
              id: item.info.id,
              role: 'assistant',
              text: textParts.join('\n'),
              toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
              metadata: {
                sessionId: item.info.sessionID,
                cost: item.info.cost,
              },
            });
          }
        }

        return { data: { items: mapped } };
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
        const result = await this.sdk.config.providers({ directory });
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
        const result = await this.sdk.app.agents({
          directory,
        });
        const error = getResultError(result);
        if (error !== undefined) {
          return { error: extractErrorMessage(error, 'List agents failed') };
        }
        const agents: AcpAgent[] = (result.data ?? []).map((a: SdkAgentData) => ({
          id: a.id ?? a.name ?? '',
          name: a.name ?? a.id,
          description: a.description,
          model: typeof a.model === 'object' && a.model !== null
            ? (a.model.modelID ?? String(a.model))
            : a.model,
          mode: a.mode as AcpAgent['mode'],
          hidden: a.hidden,
        }));
        return { data: agents };
      } catch (err) {
        return { error: extractErrorMessage(err, 'List agents failed') };
      }
    },

    get: async (directory?: string): Promise<AcpResult<AcpConfig>> => {
      try {
        const configResult = await this.sdk.config.get({
          directory,
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
          agent: raw.agent as AcpConfig['agent'],
          provider: raw.provider as AcpConfig['provider'],
        };
        return { data: config };
      } catch (err) {
        return { error: extractErrorMessage(err, 'Get config failed') };
      }
    },

    update: async (config: Partial<AcpConfig>, directory?: string): Promise<AcpResult<void>> => {
      try {
        const result = await this.sdk.config.update({
          directory,
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
  // Settings provider — declarative backend-specific settings UI
  // =======================================================================

  readonly settingsProvider = new OpenCodeSettingsProvider(this.config);

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
      const c = this.rawClient;
      if (c) {
        await this.eventBroker.ensureStarted(c);
      }
    },
  };

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
      const result = await this.sdk.permission.reply({
        requestID: permissionId,
        directory,
        reply: response,
      });
      if (result.error) {
        throw new Error(`Permission reply failed: ${extractErrorMessage(result.error, 'Unknown error')}`);
      }
    },
  };

  // =======================================================================
  // Questions
  // =======================================================================

  readonly questions: AcpQuestionOperations = {
    reply: async (
      sessionId: string,
      requestId: string,
      answers: Array<Array<string>>,
      directory?: string,
    ): Promise<AcpResult<boolean>> => {
      try {
        const result = await this.sdk.question.reply({
          requestID: requestId,
          directory,
          answers,
        });
        if (result.data !== undefined) {
          return { data: true };
        }
        return { error: `Question reply failed: ${JSON.stringify(result.error)}` };
      } catch (err) {
        return { error: extractErrorMessage(err, 'Failed to reply to question') };
      }
    },

    reject: async (
      sessionId: string,
      requestId: string,
      directory?: string,
    ): Promise<AcpResult<boolean>> => {
      try {
        const result = await this.sdk.question.reject({
          requestID: requestId,
          directory,
        });
        if (result.data !== undefined) {
          return { data: true };
        }
        return { error: `Question reject failed: ${JSON.stringify(result.error)}` };
      } catch (err) {
        return { error: extractErrorMessage(err, 'Failed to reject question') };
      }
    },
  };
}
