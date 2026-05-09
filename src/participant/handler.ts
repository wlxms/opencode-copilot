import * as vscode from 'vscode';
import { StreamBridge } from './streaming';
import { routeCommand } from './commands';
import { isEmptyPrompt, ErrorMessages } from './errors';
import type { ExtensionState } from '../types';

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

/**
 * Creates the ChatRequestHandler for the @opencode chat participant.
 *
 * Flow:
 *  1. Check cancellation
 *  2. Route slash command (if present)
 *  3. Check for empty prompt
 *  4. Start OpenCode server if not running
 *  5. Create or reuse a session
 *  6. Subscribe to SSE events
 *  7. Send the user prompt
 *  8. Bridge events to VSCode chat stream
 */
export function createParticipantHandler(
  state: ExtensionState,
): vscode.ChatRequestHandler {
  return async (
    request: vscode.ChatRequest,
    _context: vscode.ChatContext,
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

      // 5. Create or reuse session
      let sessionId = state.activeSessionId;
      if (!sessionId) {
        const result = await client.session.create({ body: {} });
        sessionId = result.data.id;
        state.activeSessionId = sessionId;
        state.outputChannel.appendLine(`[handler] Created session ${sessionId}`);
      }

      // 6. Subscribe to events BEFORE sending prompt
      const events = await client.event.subscribe();

      // 7. Fire the prompt WITHOUT awaiting — events stream concurrently.
      //    If we await prompt(), all SSE events fire during that await and
      //    are lost before bridgeEventsToStream starts consuming them.
      const promptPromise = client.session.prompt({
        path: { id: sessionId },
        body: { parts: [{ type: 'text', text: request.prompt }] },
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Prompt failed';
        state.outputChannel.appendLine(`[handler] Prompt error: ${msg}`);
      });

      // 8. Bridge events to VSCode chat stream (consumes as they arrive)
      const bridge = new StreamBridge();
      await bridge.bridgeEventsToStream(events, stream, token);

      // 9. Ensure prompt promise settles before returning
      await promptPromise;

      return { metadata: { sessionId } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unexpected error';
      stream.markdown(`⚠️ ${msg}`);
      state.outputChannel.appendLine(`[handler] Error: ${msg}`);
      return { metadata: {} };
    }
  };
}
