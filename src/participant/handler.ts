import * as vscode from 'vscode';
import { routeCommand } from './commands';
import { isEmptyPrompt, ErrorMessages } from './errors';
import { renderToolPart } from './streaming';
import type { ExtensionState, TurnMapping } from '../types';

/** Sleep for ms milliseconds */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
 *  6. Start prompt via promptAsync (returns immediately)
 *  7. Poll for progressive parts, render as they appear
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

      // 6. Start prompt processing via promptAsync (returns immediately).
      //    The server processes the prompt asynchronously. We poll for the
      //    assistant message and render its parts progressively as they appear.
      //    SSE (/event) was proven to NOT deliver session processing events —
      //    only server.connected is emitted.
      state.outputChannel.appendLine(
        `[handler] Prompting session ${sessionId} (async): ${request.prompt.substring(0, 50)}`,
      );

      await client.session.promptAsync({
        path: { id: sessionId },
        body: { parts: [{ type: 'text', text: request.prompt }] },
        query: directory ? { directory } : undefined,
      });

      // 7. Poll for progressive results.
      //    Parts appear in batches as the server generates them.
      //    We render each batch immediately for a streaming-like experience.
      let userMessageId: string | null = null;
      let lastPartCount = 0;
      let trackedMsgId: string | null = null;
      const POLL_INTERVAL = 400;       // ms between polls
      const MAX_POLL_MS = 120_000;     // 2 min timeout
      const POLL_STATUS_EVERY = 5;     // Check status every N polls

      stream.progress('🤔 Thinking...');
      const pollStart = Date.now();
      let pollCount = 0;

      while (!token.isCancellationRequested) {
        if (Date.now() - pollStart > MAX_POLL_MS) {
          state.outputChannel.appendLine(`[handler] Poll timeout (${MAX_POLL_MS}ms)`);
          break;
        }

        await sleep(POLL_INTERVAL);
        pollCount++;

        try {
          // Fetch latest messages for the session
          const msgsResult = await client.session.messages({
            path: { id: sessionId },
            query: { limit: 3 },
          });
          const msgs: Array<{ info?: { role?: string; id?: string }; parts?: Array<any> }> =
            msgsResult?.data ?? [];
          if (!Array.isArray(msgs)) continue;

          // Find the latest assistant message
          let assistantMsg: { info?: { role?: string; id?: string }; parts?: Array<any> } | null = null;
          for (const item of msgs) {
            if (item?.info?.role === 'assistant') {
              assistantMsg = item;
            }
          }
          if (!assistantMsg) continue;

          const msgId = assistantMsg.info?.id ?? '';
          const parts = assistantMsg.parts ?? [];

          // Track a new assistant message (takes over from previous)
          if (msgId !== trackedMsgId) {
            trackedMsgId = msgId;
            lastPartCount = 0;
          }

          // Render any new parts since last poll
          if (parts.length > lastPartCount) {
            for (let i = lastPartCount; i < parts.length; i++) {
              const part = parts[i];
              // Capture the first messageID as userMessageId for turn tracking
              if (!userMessageId && part.messageID) {
                userMessageId = part.messageID;
              }

              switch (part.type) {
                case 'text':
                  if (part.text) stream.markdown(part.text);
                  break;
                case 'reasoning': {
                  // Show thinking progress progressively
                  const s = stream as any;
                  if (typeof s.thinkingProgress === 'function' && part.text) {
                    s.thinkingProgress({ text: part.text, id: part.id });
                  }
                  break;
                }
                case 'tool':
                  renderToolPart(stream, part);
                  break;
                // step-start, step-finish — informational, no rendering needed
              }
            }
            lastPartCount = parts.length;
          }

          // Periodically check if the session has finished processing
          if (pollCount % POLL_STATUS_EVERY === 0) {
            try {
              const statusResult = await client.session.status();
              const sessionStatus = statusResult?.data?.[sessionId];
              if (sessionStatus?.type === 'idle') {
                // Session idle → processing done, all parts should be available.
                // Do a final fetch to catch any parts we might have missed between
                // the last message poll and the status check.
                try {
                  const finalMsgs = await client.session.messages({
                    path: { id: sessionId },
                    query: { limit: 3 },
                  });
                  const finalItems: Array<{ info?: { role?: string; id?: string }; parts?: Array<any> }> =
                    finalMsgs?.data ?? [];
                  if (Array.isArray(finalItems)) {
                    for (const item of finalItems) {
                      if (item?.info?.role === 'assistant' && (item.info.id === trackedMsgId || !trackedMsgId)) {
                        const finalParts = item.parts ?? [];
                        for (let i = lastPartCount; i < finalParts.length; i++) {
                          const p = finalParts[i];
                          if (!userMessageId && p.messageID) userMessageId = p.messageID;
                          switch (p.type) {
                            case 'text': if (p.text) stream.markdown(p.text); break;
                            case 'reasoning': {
                              const s = stream as any;
                              if (typeof s.thinkingProgress === 'function' && p.text) s.thinkingProgress({ text: p.text, id: p.id });
                              break;
                            }
                            case 'tool': renderToolPart(stream, p); break;
                          }
                        }
                        lastPartCount = Math.max(lastPartCount, finalParts.length);
                      }
                    }
                  }
                } catch {
                  // Ignore final fetch errors
                }
                break;
              }
              if (sessionStatus?.type === 'retry') {
                state.outputChannel.appendLine(
                  `[handler] Session retry: ${sessionStatus.message}`,
                );
                break;
              }
            } catch {
              // Ignore status fetch errors — keep polling
            }
          }
        } catch (err) {
          state.outputChannel.appendLine(
            `[handler] Poll error: ${err instanceof Error ? err.message : String(err)}`,
          );
          // Continue polling on transient errors
        }
      }

      // If the user cancelled, abort the session on the server
      if (token.isCancellationRequested) {
        try {
          await client.session.abort({ path: { id: sessionId } });
        } catch {
          // Ignore abort errors
        }
        return { metadata: {} };
      }

      state.outputChannel.appendLine(
        `[handler] Polling complete: ${lastPartCount} parts rendered, ${Math.round((Date.now() - pollStart) / 100) / 10}s`,
      );

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
