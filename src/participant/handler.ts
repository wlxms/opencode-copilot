import * as vscode from 'vscode';
import { StreamBridge } from './streaming';
import { routeCommand } from './commands';
import { isEmptyPrompt, ErrorMessages } from './errors';
import type { ExtensionState, OpenCodeClient, TurnMapping } from '../types';
import { ExternalEditTracker } from './external-edit-tracker';
import { collectOpenFileUris } from './checkpoint';

/**
 * Get the VSCode workspace root path for the first workspace folder.
 * Used as the project directory for OpenCode sessions.
 */
function getWorkspaceDirectory(): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  return workspaceFolders?.[0]?.uri?.fsPath;
}

/**
 * Ensure the OpenCode server is running and client is available.
 * Starts the server lazily if not already running.
 * Returns the client, or null if server failed to start.
 */
export async function ensureServer(
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
    stream.progress('🔄 Starting OpenCode...');
    // Use the current VSCode workspace directory as the server CWD
    const workspacePath = getWorkspaceDirectory();
    const url = await state.serverManager.start(workspacePath);
    state.serverStatus = 'running';
    state.client = state.serverManager.getClient();
    if (!state.client) {
      stream.markdown('⚠️ OpenCode client not available.');
      state.serverStatus = 'error';
      return null;
    }
    state.outputChannel.appendLine(`[handler] Server started at ${url}`);
    return state.client;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    stream.markdown(`⚠️ Failed to start OpenCode: ${msg}`);
    state.serverStatus = 'error';
    return null;
  }
}

// -----------------------------------------------------------------------
// Session sync: VSCode chat session → OpenCode session via request.sessionId
// -----------------------------------------------------------------------

/** Result of scanning chat history metadata for recoverable state */
interface RecoveredHistory {
  turnMap: TurnMapping[];
  sessionId: string | null;
}

/**
 * Recover turnMap and sessionId from previous ChatResponseTurn metadata in history.
 * Scans from newest to oldest, returns the first match with valid data.
 * Used for session recovery after VSCode restart and rewind/fork detection.
 */
function recoverFromHistory(context: vscode.ChatContext): RecoveredHistory {
  const history = context.history ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    // ChatResponseTurn is a proposed API — access metadata via type assertion
    const metadata = (turn as unknown as { metadata?: Record<string, unknown> })?.metadata;
    if (!metadata) continue;

    const sessionId = metadata.sessionId as string | undefined;
    const turnMapRaw = metadata.turnMap as Array<{ vscodeTurn: number; opencodeMessageId: string }> | undefined;
    if (sessionId && turnMapRaw && Array.isArray(turnMapRaw)) {
      return { sessionId, turnMap: turnMapRaw };
    }
  }
  return { sessionId: null, turnMap: [] };
}

/**
 * Resolve or create an OpenCode session for this VSCode chat.
 *
 * Handles three cases:
 * 1. **New chat** — no prior state → create a fresh OpenCode session
 * 2. **Continue** — same number of history turns → reuse existing session
 * 3. **Rewind** — fewer history turns → revert to the matching message
 *
 * Returns the OpenCode session ID, or null on error.
 */
async function resolveSession(
  client: OpenCodeClient,
  state: ExtensionState,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  vscodeSessionId: string,
  directory?: string,
): Promise<string | null> {
  // Get or create per-VSCode-chat state
  let chatState = state.sessionMap.get(vscodeSessionId);
  if (!chatState) {
    chatState = { opencodeSessionId: '', turnMap: [] };
    state.sessionMap.set(vscodeSessionId, chatState);
  }

  // Check for metadata recovery (VSCode restart / tab restore)
  if (!chatState.opencodeSessionId) {
    const recovered = recoverFromHistory(context);
    if (recovered.sessionId) {
      chatState.opencodeSessionId = recovered.sessionId;
      chatState.turnMap = recovered.turnMap;
      state.outputChannel.appendLine(
        `[handler] Recovered session from history: ${recovered.sessionId} (${recovered.turnMap.length} turns)`,
      );
    }
  }

  const history = context.history ?? [];
  const currentTurnIndex = history.length;

  // --- Case 1: New chat (no prior session) ---
  if (!chatState.opencodeSessionId) {
    const result = await client.session.create({
      body: { title: `Chat ${vscodeSessionId.slice(0, 8)}` },
      query: directory ? { directory } : undefined,
    });
    if (result.error || !result.data) {
      stream.markdown('⚠️ Failed to create OpenCode session.');
      return null;
    }
    chatState.opencodeSessionId = result.data.id;
    state.outputChannel.appendLine(
      `[handler] Created new OpenCode session ${chatState.opencodeSessionId} for VSCode chat ${vscodeSessionId}`,
    );
    return chatState.opencodeSessionId;
  }

  // --- Case 2: Continue (same turn count) ---
  if (currentTurnIndex === chatState.turnMap.length) {
    state.outputChannel.appendLine(
      `[handler] Reusing OpenCode session ${chatState.opencodeSessionId} for VSCode chat ${vscodeSessionId} (turn ${currentTurnIndex}) ` +
      `turnMap=${chatState.turnMap.length}`,
    );
    return chatState.opencodeSessionId;
  }

  // --- Case 3: Rewind (fewer turns than recorded) → revert ---
  if (currentTurnIndex < chatState.turnMap.length) {
    const priorTurnMap = chatState.turnMap.slice(0, currentTurnIndex);
    if (currentTurnIndex > 0) {
      const targetMessageId = priorTurnMap[currentTurnIndex - 1].opencodeMessageId;
      state.outputChannel.appendLine(
        `[handler] Rewind detected: reverting session ${chatState.opencodeSessionId} to message ${targetMessageId}`,
      );
      const revertResult = await client.session.revert({
        path: { id: chatState.opencodeSessionId },
        body: { messageID: targetMessageId },
        query: directory ? { directory } : undefined,
      });
      if (revertResult.error) {
        state.outputChannel.appendLine(
          `[handler] Revert failed: ${JSON.stringify(revertResult.error)} — creating new session`,
        );
        const createResult = await client.session.create({
          query: directory ? { directory } : undefined,
        });
        if (createResult.error || !createResult.data) {
          stream.markdown('⚠️ Failed to create OpenCode session after revert failure.');
          return null;
        }
        chatState.opencodeSessionId = createResult.data.id;
        chatState.turnMap = [];
        return chatState.opencodeSessionId;
      }
    } else {
      // Rewound to the beginning — no prior message to revert to
      state.outputChannel.appendLine(
        `[handler] Full rewind for session ${chatState.opencodeSessionId} — no revert needed`,
      );
    }
    chatState.turnMap = priorTurnMap;
  }
  state.outputChannel.appendLine(
    `[handler] Reusing OpenCode session ${chatState.opencodeSessionId} for VSCode chat ${vscodeSessionId} (turn ${currentTurnIndex}) ` +
    `turnMap=${chatState.turnMap.length}`,
  );
  return chatState.opencodeSessionId;
}

/**
 * Creates the ChatRequestHandler for the @opencode chat participant.
 *
 * Flow:
 *  1. Check cancellation
 *  2. Route slash command (if present)
 *  3. Check for empty prompt
 *  4. Start OpenCode server if not running
 *  5. Resolve or fork session (handles VSCode rewind)
 *  6. Subscribe to SSE events
 *  7. Send the user prompt
 *  7b. Hook cancellation → abort OpenCode backend
 *  8. Bridge events to VSCode chat stream (with per-edit externalEdit tracking)
 *  9. Record user message ID in turn map
 */
export function createParticipantHandler(
  state: ExtensionState,
): vscode.ChatRequestHandler {
  return async (
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult> => {
    const tracker = new ExternalEditTracker();
    try {
      // 1. Early cancellation check
      if (token.isCancellationRequested) {
        return { metadata: {} };
      }

      // 2. Slash command routing
      if (request.command) {
        return await routeCommand(request.command, state, stream, token);
      }

      // 3. Empty prompt check
      if (isEmptyPrompt(request.prompt)) {
        stream.markdown(ErrorMessages.EMPTY_PROMPT);
        return { metadata: {} };
      }

      // 4. Start server if needed
      const client = await ensureServer(state, stream);
      if (!client) return { metadata: {} };

      // 4b. Compute workspace directory for session/prompt API calls
      const directory = getWorkspaceDirectory();

      // 5. Resolve session (handles rewind via revert)
      // request.sessionId from chatParticipantPrivate identifies the VSCode chat
      const vscodeSessionId = request.sessionId ?? 'unknown';
      const sessionId = await resolveSession(client, state, context, stream, vscodeSessionId, directory);
      if (!sessionId) return { metadata: {} };

      const executeTurnWithBridge = async (): Promise<void> => {
        const events = state.eventBroker.openSessionStream(sessionId);
        await state.eventBroker.ensureStarted(client, state.outputChannel);

        // 7. Fire the prompt WITHOUT awaiting
        state.outputChannel.appendLine(
          `[handler] Prompting session ${sessionId} with: ${request.prompt.substring(0, 50)}`,
        );
        const promptPromise = client.session.prompt({
          path: { id: sessionId },
          body: { parts: [{ type: 'text', text: request.prompt }] },
          query: directory ? { directory } : undefined,
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : 'Prompt failed';
          state.outputChannel.appendLine(`[handler] Prompt error: ${msg}`);
        });

        // 7b. Cancel → abort OpenCode session
        let aborted = false;
        const cancelDisposable = token.onCancellationRequested(() => {
          if (aborted) return;
          aborted = true;
          state.outputChannel.appendLine(
            `[handler] Cancellation requested, aborting OpenCode session ${sessionId}`,
          );
          client.session.abort({
            path: { id: sessionId },
            query: directory ? { directory } : undefined,
          }).then((result) => {
            state.outputChannel.appendLine(
              `[handler] Abort result: ${JSON.stringify(result?.data)}`,
            );
          }).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            state.outputChannel.appendLine(`[handler] Abort error: ${msg}`);
          });
        });

        state.outputChannel.appendLine(`[handler] bridgeEventsToStream start for session ${sessionId}`);

        // Collect known file URIs for new-file detection in per-edit externalEdit flow
        let knownFileUris: string[] = [];
        try {
          knownFileUris = collectOpenFileUris().map(u => u.toString());
        } catch {
          // vscode.workspace.textDocuments may not be available (e.g., test mock)
        }

        const bridge = new StreamBridge({
          logger: state.outputChannel,
          sessionId,
          knownFileUris: new Set(knownFileUris),
          client,
          directory,
          tracker,
        });
        try {
          await bridge.bridgeEventsToStream(events, stream, token);
        } finally {
          cancelDisposable.dispose();
        }

        state.eventBroker.closeSessionStream(sessionId);

        // 9. Ensure prompt promise settles
        await promptPromise;

        // 10. Record user message ID
        const chatState = state.sessionMap.get(vscodeSessionId);
        const userMessageId = bridge.getUserMessageId();
        state.outputChannel.appendLine(
          `[handler] User message ID for turn: ${!!chatState && !!userMessageId} (${userMessageId})`,
        );
        if (chatState && userMessageId) {
          chatState.turnMap.push({
            vscodeTurn: chatState.turnMap.length,
            opencodeMessageId: userMessageId,
          });
          state.outputChannel.appendLine(
            `[handler] Recorded turn ${chatState.turnMap.length - 1}: messageID=${userMessageId} (total turns=${chatState.turnMap.length})`,
          );
        }
      };

      // 11. Execute turn with per-edit externalEdit lifecycle managed via tracker
      await executeTurnWithBridge();

      // 12. Return metadata for future turn recovery
      return {
        metadata: {
          sessionId,
          turnMap: state.sessionMap.get(vscodeSessionId)?.turnMap ?? [],
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unexpected error';
      stream.markdown(`⚠️ ${msg}`);
      state.outputChannel.appendLine(`[handler] Error: ${msg}`);
      return { metadata: {} };
    } finally {
      tracker.dispose();
    }
  };
}
