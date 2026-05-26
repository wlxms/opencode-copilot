/**
 * Chat-session-provider surface for VS Code's proposed API.
 *
 * Implements `vscode.ChatSessionContentProvider` — the proposed API that allows
 * extensions to register as a "session target" in VS Code's chat view. When
 * registered, OpenCode appears alongside Local, Copilot CLI, Cloud, Claude,
 * etc. in the Session Target dropdown at the bottom of the chat input.
 *
 * == Architecture ==
 * ```
 * VS Code chat view
 *     │
 *     ▼  Session Target: "OpenCode" selected
 * ┌─────────────────────────────────────────────┐
 * │  ChatSessionContentProvider (this module)    │
 * │  ┌───────────────────────────────────────┐  │
 * │  │ provideChatSessionContent(uri, token)  │  │
 * │  │ → fetches session history from backend │  │
 * │  │ → returns ChatSessionContent           │  │
 * │  └───────────────────────────────────────┘  │
 * │  + optional optionGroups (model picker, etc) │
 * └─────────────────────────────────────────────┘
 *     │
 *     ▼
 * OpenCodeBackend → OpenCode SDK → opencode daemon
 * ```
 *
 * == Registration ==
 * ```ts
 * // In extension.ts activate():
 * vscode.chat.registerChatSessionContentProvider(
 *   'opencode',                          // URI scheme
 *   createSessionContentProvider(state),  // provider
 *   participant,                         // ChatParticipant (@opencode)
 *   { supportsChangingSessionType: true } // capabilities
 * );
 * ```
 *
 * == Gating ==
 * Every proposed API call is gated behind runtime capability checks
 * (`hasRegisterChatSessionContentProvider()`). The extension degrades
 * gracefully to the stable participant surface when the proposed API
 * is unavailable.
 *
 * @module
 */
import * as vscode from 'vscode';
import type { ExtensionState } from '../../types';
import type { OpenCodeEvent, OpenCodeEventStream } from '../../backends/opencode/sdk-events';

import { StreamBridge } from '../../participant/streaming';
import { ExternalEditTracker } from '../../participant/external-edit-tracker';
import { collectOpenFileUris } from '../../participant/checkpoint';

import {
  AcpRenderer,
  buildToolSpecificData,
  formatInvocationMsg,
  formatPastTenseMsg,
  renderToolFallback,
} from './acp-renderer';

import {
  hasRegisterChatSessionContentProvider,
  hasThinkingProgress,
  hasToolUI,
  hasChatToolInvocationPart,
  hasChatResponseMultiDiffPart,
  hasFullProposedSurface,
} from './capabilities';

// ---------------------------------------------------------------------------
// Internal types for session content rendering (not part of the VS Code API)
// ---------------------------------------------------------------------------

/**
 * Content for a single chat session frame/response.
 * Internal representation used by `ExperimentalChatSession` before
 * converting to VS Code's `ChatSessionContent`.
 */
export interface SessionFrameContent {
  /** Markdown text content (the AI response) */
  markdown?: string;
  /** Tool invocations that occurred during this response */
  toolInvocations?: SessionToolInvocation[];
  /** Whether this frame contains reasoning (thinking) content */
  hasReasoning?: boolean;
  /** Reasoning text content, if any */
  reasoningText?: string;
  /** File diffs from this response */
  diffs?: SessionDiffEntry[];
}

export interface SessionToolInvocation {
  toolName: string;
  toolCallId: string;
  isError?: boolean;
  invocationMessage?: string | vscode.MarkdownString;
  pastTenseMessage?: string | vscode.MarkdownString;
  toolSpecificData?: Record<string, unknown>;
  isComplete?: boolean;
}

export interface SessionDiffEntry {
  file: string;
  additions?: number;
  deletions?: number;
  status: 'added' | 'modified';
}

// ---------------------------------------------------------------------------
// ExperimentalChatSession — renders ACP events into structured content
// ---------------------------------------------------------------------------

/**
 * Accumulates ACP events for a single chat turn and produces structured
 * `SessionFrameContent` that a `ChatSessionContentProvider` can surface.
 *
 * Unlike `AcpRenderer` which pushes directly to a `ChatResponseStream`,
 * this class captures rendered output as structured data for later
 * consumption by a content provider.
 */
export class ExperimentalChatSession {
  private renderer: AcpRenderer;
  private readonly logger?: { appendLine(m: string): void };

  /** Accumulated content for the current turn */
  private frames: SessionFrameContent[] = [];
  private currentFrame: SessionFrameContent = {};

  constructor(options?: { logger?: { appendLine(m: string): void } }) {
    this.renderer = new AcpRenderer(options);
    this.logger = options?.logger;
  }

  /**
   * Process an ACP event and capture it as structured content.
   * Call after each event from the OpenCode event stream.
   */
  processEvent(evt: OpenCodeEvent): void {
    switch (evt.type) {
      case 'message.part.updated':
        this.handlePartUpdated(evt);
        break;
      case 'message.part.delta':
        this.handlePartDelta(evt);
        break;
      case 'session.diff':
        this.handleSessionDiff(evt);
        break;
      case 'session.idle':
        this.flushFrame();
        break;
    }
  }

  /**
   * Get all accumulated frames and reset for the next turn.
   */
  consumeFrames(): SessionFrameContent[] {
    const result = this.frames;
    this.frames = [];
    this.currentFrame = {};
    this.renderer.reset();
    return result;
  }

  /** Get the user message ID captured during rendering */
  getUserMessageId(): string | null {
    return this.renderer.getUserMessageId();
  }

  // -------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------

  private handlePartUpdated(evt: OpenCodeEvent): void {
    const part = (evt as { properties?: { part?: { type: string } } }).properties?.part;
    if (!part) {return;}

    switch (part.type) {
      case 'reasoning':
        this.currentFrame.hasReasoning = true;
        break;
      case 'tool': {
        const toolPart = part as {
          callID?: string;
          tool?: string;
          state?: { status: string; input?: Record<string, unknown>; output?: string; title?: string; error?: string };
        };
        this.handleToolState(toolPart);
        break;
      }
    }
  }

  private handlePartDelta(evt: OpenCodeEvent): void {
    const props = (evt as { properties?: { partID: string; delta: string; field?: string } }).properties;
    if (!props?.delta) {return;}

    // We don't track part kinds here (that's the renderer's job).
    // For structured content, we accumulate into the current frame.
    if (this.currentFrame.hasReasoning) {
      this.currentFrame.reasoningText =
        (this.currentFrame.reasoningText ?? '') + props.delta;
    } else {
      this.currentFrame.markdown =
        (this.currentFrame.markdown ?? '') + props.delta;
    }
  }

  private handleSessionDiff(evt: OpenCodeEvent): void {
    const diffs = (evt as { properties?: { diff?: Array<{ file: string; additions?: number; deletions?: number; status: string }> } }).properties?.diff;
    if (!diffs?.length) {return;}

    const entries: SessionDiffEntry[] = diffs
      .filter((d) => d.status !== 'deleted')
      .map((d) => ({
        file: d.file,
        additions: d.additions,
        deletions: d.deletions,
        status: d.status === 'added' ? 'added' as const : 'modified' as const,
      }));

    if (entries.length > 0) {
      this.currentFrame.diffs = entries;
    }
  }

  private handleToolState(toolPart: {
    callID?: string;
    tool?: string;
    state?: { status: string; input?: Record<string, unknown>; output?: string; title?: string; error?: string; startTime?: number; endTime?: number };
  }): void {
    const state = toolPart.state;
    if (!state) {return;}

    const toolName = toolPart.tool ?? 'unknown';
    const callID = toolPart.callID ?? 'unknown';
    const status = state.status;

    if (status === 'completed' || status === 'error') {
      const invocation: SessionToolInvocation = {
        toolName,
        toolCallId: callID,
        isError: status === 'error',
        invocationMessage: formatInvocationMsg(toolName, state.input ?? {}, getTitle(state) ?? toolName),
        pastTenseMessage: formatPastTenseMsg(
          toolName,
          getTitle(state) ?? toolName,
          state.startTime,
          state.endTime,
          state.input ?? {},
        ),
        isComplete: true,
      };

      if (status === 'completed') {
        const data = buildToolSpecificData(
          toolName,
          getTitle(state) ?? toolName,
          state.input ?? {},
          state.output ?? '',
        );
        if (data) {
          invocation.toolSpecificData = data as unknown as Record<string, unknown>;
        }
      }

      this.currentFrame.toolInvocations ??= [];
      this.currentFrame.toolInvocations.push(invocation);
    }
  }

  private flushFrame(): void {
    if (
      this.currentFrame.markdown ||
      this.currentFrame.toolInvocations ||
      this.currentFrame.hasReasoning ||
      this.currentFrame.diffs
    ) {
      this.frames.push(this.currentFrame);
    }
    this.currentFrame = {};
  }
}

// ---------------------------------------------------------------------------
// Content provider factory
// ---------------------------------------------------------------------------

/**
 * URI scheme used to register OpenCode as a session target.
 * Must match the `type` field in the `chatSessions` contribution
 * in package.json.
 */
export const OPENCODE_SESSION_SCHEME = 'opencode-copilot.opencode';

/**
 * Create a `vscode.ChatSessionContentProvider` that registers OpenCode
 * as a session target in VS Code's chat view.
 *
 * The returned provider:
 * - `provideChatSessionContent(uri, token)` — returns a ChatSession with a
 *   `requestHandler` that routes chat requests through our OpenCode backend.
 *
 * The request handler reuses the same StreamBridge + AcpRenderer pipeline
 * as the stable participant surface, ensuring feature parity.
 *
 * @param state - The global extension state.
 * @param context - The extension context (for subscriptions).
 * @returns A `vscode.ChatSessionContentProvider` instance ready for
 *          registration via `vscode.chat.registerChatSessionContentProvider()`.
 */
export function createSessionContentProvider(
  state: ExtensionState,
  _context: vscode.ExtensionContext,
): vscode.ChatSessionContentProvider {
  const logger = state.outputChannel;

  return {
    provideChatSessionContent(
      resource: vscode.Uri,
      _token: vscode.CancellationToken,
      _context: { readonly inputState: vscode.ChatSessionInputState },
    ): vscode.ChatSession {
      logger.appendLine(
        `[session-provider] provideChatSessionContent called for ${resource.toString()}`,
      );

      return {
        history: [],

        /**
         * Request handler invoked by VS Code when the user sends a message
         * in an OpenCode session target.
         *
         * This reuses the same backend pipeline as the @opencode participant:
         *   1. Ensure server is running
         *   2. Resolve/create OpenCode session
         *   3. Send prompt and stream events through StreamBridge
         */
        requestHandler: async (
          request: vscode.ChatRequest,
          _context: vscode.ChatContext,
          stream: vscode.ChatResponseStream,
          token: vscode.CancellationToken,
        ): Promise<vscode.ChatResult> => {
          logger.appendLine(
            `[session-provider] requestHandler invoked: "${request.prompt?.substring(0, 80)}"`,
          );

          // Guard: cancellation
          if (token.isCancellationRequested) {
            stream.markdown('\u26A0\uFE0F Cancelled\n');
            return { metadata: {} };
          }

          // Guard: empty prompt
          if (!request.prompt?.trim()) {
            stream.markdown('Please enter a prompt.');
            return { metadata: {} };
          }

          // 1. Ensure backend is running
          const status = state.backend.getStatus();
          if (status !== 'running') {
            try {
              stream.progress('Starting OpenCode server...');
              const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
              const result = await state.backend.start(workspacePath);
              if (result.error || !result.data) {
                const msg = typeof result.error === 'string' ? result.error : 'Unknown error';
                stream.markdown(`\u26A0\uFE0F Failed to start OpenCode: ${msg}`);
                return { metadata: {} };
              }
              logger.appendLine(`[session-provider] Server started at ${result.data.url}`);
            } catch (err) {
              const msg = err instanceof Error ? err.message : 'Unknown error';
              stream.markdown(`\u26A0\uFE0F Failed to start OpenCode: ${msg}`);
              return { metadata: {} };
            }
          }

          // 2. Create or reuse OpenCode session
          const directory = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
          const vscodeSessionId = request.sessionId ?? `session-${Date.now()}`;
          let chatState = state.sessionMap.get(vscodeSessionId);
          if (!chatState) {
            chatState = { opencodeSessionId: '', turnMap: [] };
            state.sessionMap.set(vscodeSessionId, chatState);
          }

          if (!chatState.opencodeSessionId) {
            stream.progress('Creating new session...');
            const result = await state.backend.sessions.create({
              title: `Chat ${vscodeSessionId.slice(0, 8)}`,
              directory,
            });
            if (result.error || !result.data) {
              stream.markdown('\u26A0\uFE0F Failed to create OpenCode session.');
              return { metadata: {} };
            }
            chatState.opencodeSessionId = result.data.id ?? '';
            logger.appendLine(`[session-provider] Created session ${chatState.opencodeSessionId}`);
          }

          const sessionId = chatState.opencodeSessionId;

          // 3. Ensure event stream is connected
          stream.progress('Connecting to event stream...');
          await state.backend.events.ensureStarted();

          // 4. Open a per-session event stream
          const events = state.backend.events.openSessionStream(sessionId);

          // 5. Send prompt and stream response
          stream.progress('Sending message...');
          logger.appendLine(
            `[session-provider] Prompting session ${sessionId}: ${request.prompt.substring(0, 50)}`,
          );

          // Build prompt options from current agent/model selection
          const promptOptions: { model?: { providerID: string; modelID: string }; agent?: string } = {};
          if (state.selectedAgentOverride) {
            promptOptions.agent = state.selectedAgentOverride;
          }
          if (state.selectedModelOverride) {
            promptOptions.model = state.selectedModelOverride;
          }

          // Fire prompt (non-blocking) — events arrive through the session stream
          const promptPromise = state.backend.sessions.prompt(
            sessionId,
            request.prompt,
            directory,
            promptOptions,
          ).then((result) => {
            if (result.error) {
              logger.appendLine(`[session-provider] Prompt error: ${JSON.stringify(result.error)}`);
            }
          }).catch((err: unknown) => {
            logger.appendLine(`[session-provider] Prompt exception: ${err instanceof Error ? err.message : String(err)}`);
          });

          // 6. Render events through StreamBridge (same pipeline as @opencode participant)
          const tracker = new ExternalEditTracker();
          const bridge = new StreamBridge({
            logger: { appendLine: (m: string) => logger.appendLine(m) },
            sessionId,
            knownFileUris: new Set((await collectOpenFileUris()).map(u => u.toString())),
            tracker,
            directory,
          });

          try {
            await bridge.run(events.stream, stream, token);
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Connection lost';
            logger.appendLine(`[session-provider] Stream error: ${msg}`);
            stream.markdown(`\n\u26A0\uFE0F ${msg}\n`);
          } finally {
            state.backend.events.closeSessionStream(sessionId);
          }

          // Ensure prompt completes
          await promptPromise;

          return { metadata: {} };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: render ACP events through the experimental surface
// ---------------------------------------------------------------------------

/**
 * Render ACP events into structured session content using all available
 * proposed APIs. This function:
 *
 * 1. Uses `AcpRenderer` for core rendering.
 * 2. Also captures structured `SessionFrameContent` via
 *    `ExperimentalChatSession`.
 * 3. Gates every proposed API behind runtime checks.
 * 4. Falls back to stable APIs when proposed APIs are unavailable.
 *
 * @param renderer - Pre-configured AcpRenderer instance.
 * @param eventStream - OpenCode event stream to consume.
 * @param stream - The VS Code chat response stream to render to.
 * @param token - Cancellation token.
 * @returns Structured session frames and whether the turn completed.
 */
export async function renderWithExperimentalSurface(
  renderer: AcpRenderer,
  eventStream: OpenCodeEventStream,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<{ frames: SessionFrameContent[]; completed: boolean }> {
  const session = new ExperimentalChatSession();

  // Check stream capabilities at runtime (may or may not be available)
  const hasFullProposed = hasFullProposedSurface(stream);
  const hasToolPart = hasChatToolInvocationPart();
  const hasMultiDiff = hasChatResponseMultiDiffPart();

  const logger = { appendLine: (m: string) => { console.log(m); } };

  logger.appendLine(
    `[experimental-session] caps: fullProposed=${hasFullProposed}, ` +
    `toolPart=${hasToolPart}, multiDiff=${hasMultiDiff}`,
  );

  renderer.probeStream(stream);

  try {
    for await (const rawEvt of eventStream.stream) {
      if (token.isCancellationRequested) {
        stream.markdown('\n\u26A0\uFE0F Operation cancelled\n');
        break;
      }

      const evt = 'payload' in rawEvt ? rawEvt.payload : rawEvt;

      // Render to the live stream (uses proposed APIs if available)
      const result = renderer.renderEvent(evt, stream);

      // Also capture as structured content
      session.processEvent(evt);

      if (result.rendered) {
        await yieldToEventLoop();
      }

      if (evt.type === 'session.idle') {
        const frames = session.consumeFrames();
        return { frames, completed: true };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Connection lost';
    logger.appendLine(`[experimental-session] Error: ${msg}`);
    stream.markdown(`\n\u26A0\uFE0F ${msg}\n`);
  }

  return { frames: session.consumeFrames(), completed: false };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function getTitle(state: { title?: string }): string | undefined {
  return state.title;
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
