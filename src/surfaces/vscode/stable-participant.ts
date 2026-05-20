/**
 * Stable participant surface.
 *
 * Exposes a `ChatRequestHandler` that renders ACP events using ONLY stable
 * VS Code chat APIs (`markdown()`, `progress()`, `push()`). This surface
 * deliberately avoids any proposed API (no `thinkingProgress`,
 * `beginToolInvocation`, `ChatToolInvocationPart`, etc.) so it can be used
 * in environments where `chatParticipantAdditions` is not enabled.
 *
 * == Design ==
 * - Uses the `AcpRenderer` from `acp-renderer.ts` which already falls back
 *   to stable APIs when proposed APIs are absent. The handler passed here
 *   is deliberately a plain `vscode.ChatResponseStream` cast — no extended
 *   methods are called at the handler level.
 * - Does NOT import from the `capabilities.ts` module or use any proposed
 *   API checks. Rendering is entirely through stable paths.
 * - All tool results, reasoning, and text output are rendered via markdown
 *   strings, not native tool cards.
 *
 * == Usage ==
 * ```ts
 * import { createStableHandler } from '../surfaces/vscode/stable-participant';
 *
 * const participant = vscode.chat.createChatParticipant(
 *   'opencode-copilot.opencode',
 *   createStableHandler(state),
 * );
 * ```
 *
 * @module
 */
import * as vscode from 'vscode';
import type { OpenCodeClient, ExtensionState } from '../../types';
import type { OpenCodeEventStream } from '../../types/events';
import { AcpRenderer, renderToolFallback } from './acp-renderer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for the stable participant handler.
 * Mirrors the subset of `StreamBridgeOptions` that applies to rendering.
 */
export interface StableHandlerOptions {
  /** Logger for diagnostic output */
  logger?: { appendLine(message: string): void };
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create a `ChatRequestHandler` that renders events through the stable-only
 * rendering path. The returned handler:
 *
 * 1. Ensures the OpenCode server is running and the client is available.
 * 2. Creates an `AcpRenderer` configured to use only stable APIs.
 * 3. Streams events from the OpenCode event feed through the renderer.
 *
 * No proposed API features are used — all tool calls, reasoning, and text
 * are rendered as markdown.
 *
 * @param state - The global extension state.
 * @param options - Optional configuration.
 * @returns A `ChatRequestHandler` compatible with `vscode.chat.createChatParticipant`.
 */
export function createStableHandler(
  state: ExtensionState,
  options?: StableHandlerOptions,
): vscode.ChatRequestHandler {
  const logger = options?.logger ?? state.outputChannel;

  return async (
    request: vscode.ChatRequest,
    _context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult> => {
    logger.appendLine('[stable-participant] Handling request...');

    // 1. Ensure server is available
    const client = await ensureServer(state, stream);
    if (!client) {
      return { metadata: { error: 'Server not available' } };
    }

    // 2. Create or reuse session
    const sessionId = await resolveSession(state, client, request, logger);
    if (!sessionId) {
      stream.markdown('⚠️ Failed to create session.');
      return { metadata: { error: 'Session creation failed' } };
    }

    // 3. Send prompt
    const eventStream = await sendPrompt(client, sessionId, request.prompt, logger);
    if (!eventStream) {
      stream.markdown('⚠️ Failed to send prompt.');
      return { metadata: { error: 'Prompt failed' } };
    }

    // 4. Render events via the stable renderer
    const renderer = new AcpRenderer({ logger });
    renderer.probeStream(stream);

    try {
      for await (const rawEvt of eventStream.stream) {
        if (token.isCancellationRequested) {
          stream.markdown('\n⚠️ Operation cancelled\n');
          break;
        }

        const evt = 'payload' in rawEvt ? rawEvt.payload : rawEvt;
        const result = renderer.renderEvent(evt, stream);

        if (result.rendered) {
          await yieldToEventLoop();
        }

        if (evt.type === 'session.idle') {
          logger.appendLine('[stable-participant] Session idle — turn complete');
          break;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection lost';
      logger.appendLine(`[stable-participant] Error: ${msg}`);
      stream.markdown(`\n⚠️ ${msg}\n`);
    } finally {
      renderer.reset();
    }

    return { metadata: { sessionId } };
  };
}

// =======================================================================
// Internal helpers (simplified versions of handler.ts logic)
// =======================================================================

/**
 * Ensure the OpenCode server is running and return a client.
 */
async function ensureServer(
  state: ExtensionState,
  stream: vscode.ChatResponseStream,
): Promise<OpenCodeClient | null> {
  if (state.client) {
    return state.client;
  }

  if (state.serverStatus === 'starting') {
    stream.markdown('⚠️ OpenCode server is starting up, please wait...');
    return null;
  }

  try {
    stream.progress('\u{1F504} Starting OpenCode...');
    const workspacePath = getWorkspaceDirectory();
    const url = await state.serverManager.start(workspacePath);
    state.serverStatus = 'running';
    state.client = state.serverManager.getClient();
    if (!state.client) {
      stream.markdown('⚠️ OpenCode client not available.');
      state.serverStatus = 'error';
      return null;
    }
    state.outputChannel.appendLine(`[stable-participant] Server started at ${url}`);
    return state.client;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    stream.markdown(`\u26A0\uFE0F Failed to start OpenCode: ${msg}`);
    state.serverStatus = 'error';
    return null;
  }
}

/**
 * Resolve an OpenCode session ID — creating one if necessary.
 * Simplified version of the session recovery logic from handler.ts.
 */
async function resolveSession(
  state: ExtensionState,
  client: OpenCodeClient,
  _request: vscode.ChatRequest,
  logger: { appendLine(m: string): void },
): Promise<string | null> {
  // Try to reuse existing session from sessionMap
  const vscodeSessionId = _request.sessionId;
  if (vscodeSessionId) {
    const existing = state.sessionMap.get(vscodeSessionId);
    if (existing?.opencodeSessionId) {
      logger.appendLine(`[stable-participant] Reusing session ${existing.opencodeSessionId}`);
      return existing.opencodeSessionId;
    }
  }

  // Create new session
  try {
    const resp = await client.session.create({
      query: { directory: getWorkspaceDirectory() },
    });
    const opencodeSessionId = resp.data?.id ?? null;
    if (!opencodeSessionId) {
      return null;
    }

    if (vscodeSessionId) {
      state.sessionMap.set(vscodeSessionId, {
        opencodeSessionId,
        turnMap: [],
      });
    }

    logger.appendLine(`[stable-participant] Created session ${opencodeSessionId}`);
    return opencodeSessionId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown';
    logger.appendLine(`[stable-participant] Session creation error: ${msg}`);
    return null;
  }
}

/**
 * Send a prompt to an OpenCode session and return the event stream.
 */
async function sendPrompt(
  client: OpenCodeClient,
  sessionId: string,
  prompt: string,
  logger: { appendLine(m: string): void },
): Promise<OpenCodeEventStream | null> {
  try {
    const eventResp = await client.global.event();
    logger.appendLine('[stable-participant] Subscribing to global event feed');

    const promptResp = await client.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: 'text' as const, text: prompt }] },
      query: { directory: getWorkspaceDirectory() },
    });

    if (promptResp.error) {
      logger.appendLine(`[stable-participant] Prompt error: ${JSON.stringify(promptResp.error)}`);
      return null;
    }

    return eventResp;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown';
    logger.appendLine(`[stable-participant] sendPrompt error: ${msg}`);
    return null;
  }
}

function getWorkspaceDirectory(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders?.[0]?.uri?.fsPath;
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
