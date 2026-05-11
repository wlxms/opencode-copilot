import * as vscode from 'vscode';
import { routeCommand } from './commands';
import { isEmptyPrompt, ErrorMessages } from './errors';
import type { ExtensionState, TurnMapping } from '../types';

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
): Promise<any | null> {
  if (state.client) {
    return state.client;
  }

  if (state.serverStatus === 'starting') {
    stream.markdown('⚠️ OpenCode server is starting up, please wait...');
    return null;
  }

  try {
    stream.progress('🔄 Starting OpenCode...');
    const url = await state.serverManager.start();
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

/**
 * Recover turnMap from previous ChatResponseTurn metadata in history.
 * Used only for rewind/fork detection — session identity comes from
 * state.sessionMap keyed by request.sessionId.
 */
function recoverTurnMapFromHistory(
  context: vscode.ChatContext,
): TurnMapping[] {
  const history = context.history;
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (turn instanceof vscode.ChatResponseTurn) {
      const meta = turn.result?.metadata as {
        turnMap?: TurnMapping[];
      } | undefined;
      if (meta?.turnMap && meta.turnMap.length > 0) {
        return meta.turnMap;
      }
    }
  }
  return [];
}

/**
 * Resolve or create the correct OpenCode session for this request.
 *
 * Uses request.sessionId to look up per-chat state (sessionMap<SessionState>).
 * Each VSCode chat has its own turnMap, so switching chats doesn't lose rewind context.
 */
async function resolveSession(
  client: any,
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

  // --- No mapping: new VSCode chat → create fresh OpenCode session ---
  if (!chatState) {
    const result = await client.session.create({
      body: {},
      query: directory ? { directory } : undefined,
    });
    const sessionId = result.data?.id ?? result.id;
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
  const priorTurnMap = recoverTurnMapFromHistory(context);
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
            `[handler] → reverted turn ${entry.vscodeTurn}: ${entry.opencodeMessageId}`,
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
      stream.progress(`\u{1F519} Undone to checkpoint`);
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
      const sessionId = result.data?.id ?? result.id;
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
 *  6. Send prompt via POST /session/{id}/message (synchronous)
 *  7. Render response parts directly to VSCode stream
 *  8. Record user message ID in turn map
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

      // 5. Resolve session (handles rewind via fork)
      // request.sessionId from chatParticipantPrivate identifies the VSCode chat
      const vscodeSessionId = request.sessionId ?? 'unknown';
      const sessionId = await resolveSession(client, state, context, stream, vscodeSessionId, directory);
      if (!sessionId) return { metadata: {} };

      // 6. Send the prompt and wait for the full response.
      //    prompt() POST /session/{id}/message is synchronous — it waits
      //    for the server to finish processing and returns the full result
      //    with data.parts containing all response parts (text, reasoning, tool, etc.).
      //    Server-Sent Events (SSE) via /event only deliver server-level events
      //    (server.connected) — session processing events DO NOT flow through SSE.
      state.outputChannel.appendLine(
        `[handler] Prompting session ${sessionId} with: ${request.prompt.substring(0, 50)}`,
      );

      const result = await client.session.prompt({
        path: { id: sessionId },
        body: { parts: [{ type: 'text', text: request.prompt }] },
        query: directory ? { directory } : undefined,
      });

      state.outputChannel.appendLine(
        `[handler] Prompt completed: parts=${result?.data?.parts?.length ?? 0}`,
      );

      // 7. Render the response parts directly to the VSCode chat stream.
      //    No SSE subscription needed — the full response is in result.data.parts.
      const parts: Array<{ type: string; text?: string; messageID?: string; id?: string; [key: string]: any }> = result?.data?.parts ?? [];
      let userMessageId: string | null = null;

      for (const part of parts) {
        if (token.isCancellationRequested) break;

        // Capture the first messageID as userMessageId for turn tracking
        if (!userMessageId && part.messageID) {
          userMessageId = part.messageID;
        }

        switch (part.type) {
          case 'text': {
            // Render AI text response
            if (part.text) {
              stream.markdown(part.text);
            }
            break;
          }
          case 'reasoning': {
            // Show thinking progress (proposed API)
            const s = stream as any;
            if (typeof s.thinkingProgress === 'function' && part.text) {
              s.thinkingProgress({ text: part.text, id: part.id });
            }
            break;
          }
          // tool, step-start, step-finish — skipped for now
        }
      }

      // 8. Record the user message ID for per-chat turn tracking.
      //    userMessageId is the text part's messageID from the server response,
      //    representing the AI-generated message that corresponds to this turn.
      const chatState = state.sessionMap.get(vscodeSessionId);
      if (chatState && userMessageId) {
        chatState.turnMap.push({
          vscodeTurn: chatState.turnMap.length,
          opencodeMessageId: userMessageId,
        });
        state.outputChannel.appendLine(
          `[handler] Recorded turn ${chatState.turnMap.length - 1}: messageID=${userMessageId} (total turns=${chatState.turnMap.length})`,
        );
      }

      // 9. Return metadata for future turn recovery
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
