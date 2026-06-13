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
import type { ExtensionState } from '../../types';
import { AcpRenderer, renderToolFallback } from './acp-renderer';
import { extractAttachmentsFromReferences } from '../../participant/references';
import { resolvePromptModel } from '../../participant/handler';

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
    const ready = await ensureServer(state, stream);
    if (!ready) {
      return { metadata: { error: 'Server not available' } };
    }

    // 2. Create or reuse session
    const sessionId = await resolveSession(state, stream, request, logger);
    if (!sessionId) {
      stream.markdown('⚠️ Failed to create session.');
      return { metadata: { error: 'Session creation failed' } };
    }

    // 3. Extract image attachments and non-image path references from
    // VSCode chat references.  Images become binary attachments that the
    // backend embeds; non-image files/dirs are surfaced as plain paths
    // in the prompt text so the model can read them with tools instead
    // of having the backend slurp the bytes and base64-encode them.
    const workspaceDirectory = getWorkspaceDirectory();
    const { attachments, paths } = extractAttachmentsFromReferences(
      request.references,
      workspaceDirectory,
      logger,
    );
    if (attachments.length > 0) {
      logger.appendLine(`[stable-participant] Extracted ${attachments.length} image attachment(s) from references`);
    }
    if (paths.length > 0) {
      logger.appendLine(`[stable-participant] Extracted ${paths.length} path reference(s) from references`);
    }

    // 4. Build prompt options (agent/model + attachments) and send prompt.
    // Model resolution prefers request.model (native VS Code picker) over the
    // extension's own SelectionStore to avoid stale custom state.
    const promptOptions: {
      model?: { providerID: string; modelID: string };
      agent?: string;
      attachments?: typeof attachments;
    } = {};
    const sel = state.selection.get();
    if (sel.agent) {promptOptions.agent = sel.agent;}
    // Resolve model: native VS Code picker → backend match → SelectionStore fallback
    const resolvedModel = await resolvePromptModel(request, state);
    if (resolvedModel) {promptOptions.model = resolvedModel;}
    if (attachments.length > 0) {promptOptions.attachments = attachments;}

    // Inject referenced paths into the prompt so the model knows about
    // them without us shipping their bytes.
    const promptText = paths.length > 0
      ? prependReferencedPaths(request.prompt, paths, logger)
      : request.prompt;

    const promptResult = await state.backend.sessions.prompt(
      sessionId,
      promptText,
      workspaceDirectory,
      promptOptions,
    );
    if (promptResult.error) {
      stream.markdown('⚠️ Failed to send prompt.');
      return { metadata: { error: 'Prompt failed' } };
    }

    // 5. Open event stream for this session
    const eventStream = state.backend.events.openSessionStream(sessionId);

    // 5. Render events via the stable renderer
    const renderer = new AcpRenderer({ logger });
    renderer.probeStream(stream);

    try {
      for await (const rawEvt of eventStream.stream) {
        if (token.isCancellationRequested) {
          stream.markdown('\n⚠️ Operation cancelled\n');
          break;
        }

        const renderResult = renderer.renderEvent(rawEvt as unknown as never, stream);

        if ((renderResult as { rendered?: boolean }).rendered) {
          await yieldToEventLoop();
        }

        if (rawEvt.type === 'session.idle') {
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
      state.backend.events.closeSessionStream(sessionId);
    }

    return { metadata: { sessionId } };
  };
}

// =======================================================================
// Internal helpers
// =======================================================================

/**
 * Ensure the OpenCode server is running.
 */
async function ensureServer(
  state: ExtensionState,
  stream: vscode.ChatResponseStream,
): Promise<boolean> {
  const status = state.backend.getStatus();
  if (status === 'running') {
    return true;
  }

  if (status === 'starting') {
    stream.markdown('⚠️ OpenCode server is starting up, please wait...');
    return false;
  }

  try {
    stream.progress('\u{1F504} Starting OpenCode...');
    const workspacePath = getWorkspaceDirectory();
    const result = await state.backend.start(workspacePath);
    if (result.error || !result.data) {
      const msg = typeof result.error === 'string' ? result.error : 'Unknown error';
      stream.markdown(`⚠️ Failed to start OpenCode: ${msg}`);
      return false;
    }
    state.outputChannel.appendLine(`[stable-participant] Server started at ${result.data.url}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    stream.markdown(`\u26A0\uFE0F Failed to start OpenCode: ${msg}`);
    return false;
  }
}

/**
 * Resolve an OpenCode session ID — creating one if necessary.
 */
async function resolveSession(
  state: ExtensionState,
  stream: vscode.ChatResponseStream,
  _request: vscode.ChatRequest,
  logger: { appendLine(m: string): void },
): Promise<string | null> {
  // Try to reuse existing session from sessionMap
  const vscodeSessionId = _request.sessionId;
  if (vscodeSessionId) {
    const existing = state.sessions.get(vscodeSessionId);
    if (existing?.backendSessionId) {
      logger.appendLine(`[stable-participant] Reusing session ${existing.backendSessionId}`);
      return existing.backendSessionId;
    }
  }

  // Create new session
  try {
    const result = await state.backend.sessions.create({
      directory: getWorkspaceDirectory(),
    });
    const sessionId = result.data?.id ?? null;
    if (!sessionId) {
      stream.markdown('⚠️ Failed to create session.');
      return null;
    }

    if (vscodeSessionId) {
      state.sessions.set(vscodeSessionId, {
        backendSessionId: sessionId,
        turnMap: [],
      });
    }

    logger.appendLine(`[stable-participant] Created session ${sessionId}`);
    return sessionId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown';
    logger.appendLine(`[stable-participant] Session creation error: ${msg}`);
    return null;
  }
}

function getWorkspaceDirectory(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders?.[0]?.uri?.fsPath;
}

/**
 * Prepend a short, machine-friendly header listing the non-image paths
 * the user referenced, so the model knows which files exist without us
 * having to inline their contents.
 */
function prependReferencedPaths(
  prompt: string,
  paths: readonly string[],
  logger?: { appendLine(message: string): void },
): string {
  if (paths.length === 0) {return prompt;}
  const list = paths.map((p) => `- ${p}`).join('\n');
  const header = `The user has referenced the following paths:\n${list}\n\n`;
  logger?.appendLine(`[stable-participant] Prepended ${paths.length} path reference(s) to prompt`);
  return header + prompt;
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
