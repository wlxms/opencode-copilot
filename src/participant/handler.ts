import * as vscode from 'vscode';
import { StreamBridge } from './streaming';
import { routeCommand } from './commands';
import { isEmptyPrompt, ErrorMessages } from './errors';
import type { ExtensionState, OpenCodeClient, TurnMapping } from '../types';

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
function recoverFromHistory(
  context: vscode.ChatContext,
): RecoveredHistory {
  const history = context.history;
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (turn instanceof vscode.ChatResponseTurn) {
      const meta = turn.result?.metadata as {
        turnMap?: TurnMapping[];
        sessionId?: string;
      } | undefined;
      if (meta) {
        return {
          turnMap: meta.turnMap ?? [],
          sessionId: meta.sessionId ?? null,
        };
      }
    }
  }
  return { turnMap: [], sessionId: null };
}

/**
 * Resolve or create the correct OpenCode session for this request.
 *
 * Uses request.sessionId to look up per-chat state (sessionMap<SessionState>).
 * Each VSCode chat has its own turnMap, so switching chats doesn't lose rewind context.
 */
async function resolveSession(
  client: OpenCodeClient,
  state: ExtensionState,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  vscodeSessionId: string,
  directory?: string,
): Promise<string | null> {

  // Count prior request turns for rewind detection
  const requestTurns = context.history.filter(
    (h): h is vscode.ChatRequestTurn => h instanceof vscode.ChatRequestTurn,
  );
  const currentTurnIndex = requestTurns.length;

  // Look up per-chat session state
  const chatState = state.sessionMap.get(vscodeSessionId);

  state.outputChannel.appendLine(
    `[handler] resolveSession: vscodeId=${vscodeSessionId}, ` +
    `currentTurn=${currentTurnIndex}, ` +
    `hasChatState=${!!chatState}, ` +
    `sessionMapSize=${state.sessionMap.size}`,
  );

  // --- No mapping: try to recover from history metadata, or create fresh ---
  if (!chatState) {
    const recovered = recoverFromHistory(context);

    // Attempt to recover a previously used OpenCode session from chat history
    if (recovered.sessionId) {
      state.outputChannel.appendLine(
        `[handler] No sessionMap entry for ${vscodeSessionId}, found sessionId=${recovered.sessionId} in history metadata`,
      );

      try {
        // Verify the session still exists on the OpenCode server
        const sessionResult = await client.session.get({
          path: { id: recovered.sessionId },
          query: directory ? { directory } : undefined,
        });
        const existingId = sessionResult.data?.id;
        if (existingId) {
          // Session is valid — restore the mapping
          const turnMap = recovered.turnMap;
          state.activeSessionId = recovered.sessionId;
          state.sessionMap.set(vscodeSessionId, {
            opencodeSessionId: recovered.sessionId,
            turnMap,
          });
          state.outputChannel.appendLine(
            `[handler] Recovered OpenCode session ${recovered.sessionId} for VSCode chat ${vscodeSessionId} (turnMap=${turnMap.length})`,
          );
          return recovered.sessionId;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        state.outputChannel.appendLine(
          `[handler] Recovered session ${recovered.sessionId} not found or expired (${msg}), creating new session`,
        );
      }
    }

    // Fallback: create a fresh OpenCode session
    const result = await client.session.create({
      body: {},
      query: directory ? { directory } : undefined,
    });
    const sessionId = result.data?.id;
    if (!sessionId) {
      return null;
    }
    state.activeSessionId = sessionId;
    state.sessionMap.set(vscodeSessionId, {
      opencodeSessionId: sessionId,
      turnMap: [],
    });
    state.outputChannel.appendLine(
      `[handler] New VSCode chat ${vscodeSessionId} -> created OpenCode session ${sessionId}`,
    );
    return sessionId;
  }

  // --- Existing chat: check for rewind using per-chat turnMap ---
  const priorTurnMap = recoverFromHistory(context).turnMap;
  const perChatTurnMap = chatState.turnMap;
  const expectedTurns = Math.max(perChatTurnMap.length, priorTurnMap.length);

  state.outputChannel.appendLine(
    `[handler] Rewind check: vscodeId=${vscodeSessionId}, ` +
    `currentTurn=${currentTurnIndex}, expectedTurns=${expectedTurns}, ` +
    `perChatMap=${perChatTurnMap.length}, metadataMap=${priorTurnMap.length}, ` +
    `willFork=${currentTurnIndex < expectedTurns}`,
  );

  // --- Rewind detected: fewer turns in history than we know about ---
  if (expectedTurns > 0 && currentTurnIndex < expectedTurns) {
    const fullMap =
      perChatTurnMap.length >= priorTurnMap.length
        ? perChatTurnMap
        : priorTurnMap;
    // The message just BEFORE the rewind point — keep this as context anchor
    const anchorEntry =
      currentTurnIndex > 0
        ? fullMap[currentTurnIndex - 1]
        : undefined;

    try {
      // Revert unwanted messages (undo file changes)
      let reverted = 0;
      for (let i = expectedTurns - 1; i >= currentTurnIndex; i--) {
        const entry = fullMap[i];
        if (entry?.opencodeMessageId) {
          await client.session.revert({
            path: { id: chatState.opencodeSessionId },
            body: { messageID: entry.opencodeMessageId },
            query: directory ? { directory } : undefined,
          });
          reverted++;
          state.outputChannel.appendLine(
            `[handler] ↩ reverted turn ${entry.vscodeTurn}: ${entry.opencodeMessageId}`,
          );
        }
      }
      // Same session, trim turnMap, remember anchor for prompt
      chatState.turnMap = fullMap.slice(0, currentTurnIndex);
      state.activeSessionId = chatState.opencodeSessionId;
      state.outputChannel.appendLine(
        `[handler] Reverted ${reverted} messages, rewound to turn ${currentTurnIndex}, ` +
        `anchor=${anchorEntry?.opencodeMessageId ?? 'none'}`,
      );
      stream.progress(`🔙 Undone to checkpoint`);
      return chatState.opencodeSessionId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state.outputChannel.appendLine(
        `[handler] Revert failed (${msg}), creating new session`,
      );
      const result = await client.session.create({
        body: {},
        query: directory ? { directory } : undefined,
      });
      const sessionId = result.data?.id;
      if (!sessionId) {
        return null;
      }
      chatState.opencodeSessionId = sessionId;
      chatState.turnMap = [];
      state.activeSessionId = sessionId;
      return sessionId;
    }
  }

  // --- Normal continuation: reuse existing OpenCode session ---
  state.activeSessionId = chatState.opencodeSessionId;
  // Only restore from metadata if it's more complete than per-chat turnMap
  if (priorTurnMap.length > perChatTurnMap.length) {
    state.outputChannel.appendLine(
      `[handler] Restoring turnMap from metadata: ${priorTurnMap.length} > ${perChatTurnMap.length}`,
    );
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
 *  8. Bridge events to VSCode chat stream
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

      const events = state.eventBroker.openSessionStream(sessionId);
      // 6. Ensure the shared global-event broker is running after the session queue exists
      await state.eventBroker.ensureStarted(client, state.outputChannel);

      // 7. Fire the prompt WITHOUT awaiting — events stream concurrently.
      //    If we await prompt(), all SSE events fire during that await and
      //    are lost before bridgeEventsToStream starts consuming them.
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

      // 7b. Subscribe to VSCode cancellation → abort OpenCode session.
      //     When the user clicks "Stop" in the chat UI, VSCode fires
      //     CancellationToken.onCancellationRequested. We forward this
      //     to the OpenCode backend via session.abort() to stop ongoing
      //     AI processing, tool execution, and token generation.
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
      // 8. Bridge events to VSCode chat stream (consumes as they arrive)
      const bridge = new StreamBridge({ logger: state.outputChannel, sessionId });
      try {
        await bridge.bridgeEventsToStream(events, stream, token);
      } finally {
        cancelDisposable.dispose();
      }

      state.eventBroker.closeSessionStream(sessionId);

      // 9. Ensure prompt promise settles before returning
      await promptPromise;

      // 10. Record the user message ID for per-chat turn tracking
      const chatState = state.sessionMap.get(vscodeSessionId);
      const userMessageId = bridge.getUserMessageId();
      state.outputChannel.appendLine(
        `[handler] User message ID for turn chatState && userMessageId: ${!!chatState && !!userMessageId} (${userMessageId})`,
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

      // 12. Return metadata for future turn recovery
      return {
        metadata: {
          sessionId,
          turnMap: chatState?.turnMap ?? [],
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unexpected error';
      stream.markdown(`⚠️ ${msg}`);
      state.outputChannel.appendLine(`[handler] Error: ${msg}`);
      return { metadata: {} };
    }
  };
}
