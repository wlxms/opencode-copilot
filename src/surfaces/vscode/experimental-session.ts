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
import { createParticipantHandler } from '../../participant/handler';


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
 * == Picker Architecture ==
 * We create a `ChatSessionItemController` alongside the content provider.
 * The controller's `getChatSessionInputState` creates tracked inputState
 * objects via `controller.createChatSessionInputState()`. VSCode monitors
 * these objects, so `inputState.onDidChange` actually fires when the user
 * changes picker selections — unlike inputState received from the content
 * provider's context, which is NOT tracked by VSCode.
 *
 * Flow:
 * 1. Controller's `getChatSessionInputState` → creates tracked inputState
 * 2. VSCode tracks it, fires `onDidChange` when user changes picker
 * 3. We subscribe to `onDidChange` → parse groups → update state.currentAgent/currentModel
 * 4. Handler reads state.currentAgent/currentModel at prompt time
 *
 * @param state - The global extension state.
 * @param context - The extension context (for subscriptions).
 * @returns Object with `provider` (ChatSessionContentProvider) and
 *          `controller` (ChatSessionItemController), both ready for registration.
 */
export function createSessionContentProvider(
  state: ExtensionState,
  context: vscode.ExtensionContext,
): {
  provider: vscode.ChatSessionContentProvider;
  controller: vscode.ChatSessionItemController | undefined;
} {
  const logger = state.outputChannel;

  // -- Option Groups: Agent & Model pickers --------------------------------

  const onDidChangeOptionsEmitter = new vscode.EventEmitter<void>();
  let cachedOptionGroups: vscode.ChatSessionProviderOptionGroup[] = [];

  /** Build option groups from backend config */
  async function refreshOptionGroups(): Promise<void> {
    try {
      const directory = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;

      logger.appendLine(`[session-provider] Refreshing option groups (backend running=${state.backend.isRunning()})...`);

      // Fetch agents and models in parallel
      const [agentsResult, modelsResult] = await Promise.all([
        state.backend.config.agents(directory),
        state.backend.config.models(directory),
      ]);

      const agents = (agentsResult.data ?? []).filter(a => !a.hidden);
      const models = modelsResult.data ?? [];

      logger.appendLine(
        `[session-provider] Backend returned: ${agentsResult.data?.length ?? 0} agents (error=${agentsResult.error ?? 'none'}), ${modelsResult.data?.length ?? 0} models (error=${modelsResult.error ?? 'none'})`,
      );

      // Build agent option items
      const agentItems: vscode.ChatSessionProviderOptionItem[] = agents.map(a => ({
        id: `agent-${a.id}`,
        name: a.name ?? a.id,
        description: a.description,
        default: a.id === state.currentAgent,
      }));

      // Find selected agent item
      const currentAgentId = state.currentAgent;
      const selectedAgent = agentItems.find(i => i.id === `agent-${currentAgentId}`) ?? agentItems[0];

      // Build model option items
      const modelItems: vscode.ChatSessionProviderOptionItem[] = models.map(m => ({
        id: `model-${m.provider ?? 'default'}/${m.id}`,
        name: m.name ?? m.id,
        description: m.providerName,
        default: m.id === (state.currentModel?.modelID),
      }));

      // Find selected model item — match by both provider and model ID
      const currentModelId = state.currentModel?.modelID;
      const currentProviderId = state.currentModel?.providerID;
      let selectedModel = modelItems[0];
      if (currentModelId) {
        // First try exact match with provider
        if (currentProviderId) {
          selectedModel = modelItems.find(i => i.id === `model-${currentProviderId}/${currentModelId}`) ?? modelItems[0];
        }
        // Fallback: match by model ID only
        if (selectedModel === modelItems[0] && currentModelId !== modelItems[0]?.id.split('/').pop()) {
          selectedModel = modelItems.find(i => {
            const parts = i.id.split('/');
            return parts[parts.length - 1] === currentModelId;
          }) ?? modelItems[0];
        }
      }

      cachedOptionGroups = [
        ...(agentItems.length > 0 ? [{
          id: 'agents',
          name: 'Agent',
          items: agentItems,
          selected: selectedAgent,
        }] : []),
        ...(modelItems.length > 0 ? [{
          id: 'models',
          name: 'Model',
          items: modelItems,
          selected: selectedModel,
        }] : []),
      ];

      onDidChangeOptionsEmitter.fire();
      logger.appendLine(
        `[session-provider] Option groups refreshed: ${agentItems.length} agents, ${modelItems.length} models`,
      );
    } catch (err) {
      logger.appendLine(
        `[session-provider] Failed to refresh option groups: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Kick off initial load (non-blocking, fires event when ready).
  // This will likely fail if the backend isn't running yet — that's fine,
  // provideChatSessionProviderOptions will be called again when the event fires.
  refreshOptionGroups().catch(err => {
    logger.appendLine(`[session-provider] Initial option groups load failed (will retry on first use): ${err}`);
  });

  // -- ChatSessionItemController: Picker Tracking --------------------------
  // The controller creates tracked inputState objects via createChatSessionInputState().
  // VSCode monitors these objects, so onDidChange actually fires when the user
  // changes picker selections. Without the controller, inputState.onDidChange
  // is dead (VSCode only tracks inputStates from controllers).

  const chat = vscode.chat as Record<string, unknown>;
  const hasControllerAPI = typeof chat.createChatSessionItemController === 'function';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let controller: vscode.ChatSessionItemController | undefined;

  if (hasControllerAPI) {
    controller = (vscode.chat as any).createChatSessionItemController(
      OPENCODE_SESSION_SCHEME,
      async (_token: vscode.CancellationToken) => {
        // Refresh handler — called when VSCode wants to refresh session items.
        // We don't manage session items, so this is a no-op.
        await refreshOptionGroups();
      },
    ) as vscode.ChatSessionItemController;

    controller.getChatSessionInputState = (
      _sessionResource: vscode.Uri | undefined,
      _context: { readonly previousInputState: vscode.ChatSessionInputState | undefined },
      _token: vscode.CancellationToken,
    ): vscode.ChatSessionInputState => {
      // Create a tracked inputState from our option groups.
      // VSCode monitors this object — when the user changes a picker selection,
      // onDidChange fires on the returned inputState.
      const inputState = controller!.createChatSessionInputState(cachedOptionGroups);

      // Subscribe to changes — update state.currentAgent/currentModel in real-time.
      inputState.onDidChange(() => {
        const groups = inputState.groups ?? [];
        logger.appendLine(
          `[session-provider] Picker changed: ${groups.length} groups` +
          groups.map(g => ` [${g.id}] selected=${g.selected?.id ?? '(none)'}`).join(''),
        );

        for (const group of groups) {
          const selected = group.selected;
          if (!selected) { continue; }

          if (group.id === 'agents') {
            const agentId = selected.id.replace(/^agent-/, '');
            state.currentAgent = agentId;
            logger.appendLine(`[session-provider] Picker set currentAgent=${agentId}`);
          }

          if (group.id === 'models') {
            const modelPart = selected.id.replace(/^model-/, '');
            const slashIdx = modelPart.indexOf('/');
            if (slashIdx >= 0) {
              const providerID = modelPart.slice(0, slashIdx);
              const modelID = modelPart.slice(slashIdx + 1);
              state.currentModel = { providerID, modelID };
              logger.appendLine(`[session-provider] Picker set currentModel=${providerID}/${modelID}`);
            }
          }
        }
      });

      inputState.onDidDispose(() => {
        logger.appendLine(`[session-provider] InputState disposed for ${_sessionResource?.toString() ?? 'new session'}`);
      });

      return inputState;
    };

    logger.appendLine(`[session-provider] ChatSessionItemController created (id=${controller.id})`);
  } else {
    logger.appendLine('[session-provider] ChatSessionItemController API not available — picker changes will NOT propagate');
  }

  // -- Session History Restoration -----------------------------------------

  /**
   * Extract session ID from the resource URI.
   * URI format: opencode-copilot.opencode:/<sessionId>
   */
  function extractSessionId(resource: vscode.Uri): string {
    const path = resource.path;
    // Remove leading slash
    return path.startsWith('/') ? path.slice(1) : path;
  }

  /**
   * Fetch message history from the backend and map to VSCode turn format.
   */
  async function fetchSessionHistory(
    sessionId: string,
    token: vscode.CancellationToken,
  ): Promise<(vscode.ChatRequestTurn | vscode.ChatResponseTurn)[]> {
    const result = await state.backend.sessions.messages(sessionId);
    if (result.error || !result.data) {
      logger.appendLine(
        `[session-provider] Failed to fetch history for ${sessionId}: ${result.error ?? 'no data'}`,
      );
      return [];
    }

    const messages = result.data.items;
    const history: (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[] = [];
    const turnMap: Array<{ vscodeTurn: number; opencodeMessageId: string }> = [];
    let turnIndex = 0;

    for (const msg of messages) {
      if (token.isCancellationRequested) { break; }

      if (msg.role === 'user') {
        history.push(createRequestTurn(
          msg.text,
          undefined, // command
          [],        // references
        ));
      } else if (msg.role === 'assistant') {
        const responses: vscode.ChatResponseMarkdownPart[] = [];

        // Add text as markdown response
        if (msg.text) {
          responses.push(new vscode.ChatResponseMarkdownPart(msg.text));
        }

        // Build turn metadata for session recovery
        const turnMetadata: Record<string, unknown> = {
          sessionId,
          turnMap: [...turnMap],
        };

        history.push(createResponseTurn(
          responses,
          { metadata: turnMetadata },
        ));

        turnMap.push({
          vscodeTurn: turnIndex,
          opencodeMessageId: msg.id,
        });
        turnIndex++;
      }
    }

    logger.appendLine(
      `[session-provider] Restored ${history.length} turns for session ${sessionId}`,
    );
    return history;
  }

  // -- The Provider --------------------------------------------------------
  // Following the Copilot CLI pattern: the session provider only provides content
  // (history, title) and manages option groups (agent/model picker).
  // All request handling is delegated to the same ChatParticipant handler used
  // by the stable surface (participant/handler.ts), ensuring a shared session
  // lifecycle. Picker changes update state.currentAgent/currentModel via the
  // controller's tracked inputState.onDidChange, and the handler reads from
  // state at prompt time.

  const provider: vscode.ChatSessionContentProvider = {
    /**
     * Called by VSCode at registration time and whenever
     * onDidChangeChatSessionProviderOptions fires.
     * Returns the option groups (agent picker, model picker).
     */
    provideChatSessionProviderOptions(
      _token: vscode.CancellationToken,
    ): vscode.Thenable<vscode.ChatSessionProviderOptions> {
      // If we have cached groups, return them immediately.
      // Otherwise trigger a refresh and return the promise.
      if (cachedOptionGroups.length > 0) {
        return { optionGroups: cachedOptionGroups };
      }

      // Backend might be running now — try to load
      return refreshOptionGroups().then(() => ({
        optionGroups: cachedOptionGroups,
      }));
    },

    /**
     * Fired when option groups change (backend starts, config changes).
     * VSCode will re-call provideChatSessionProviderOptions.
     */
    onDidChangeChatSessionProviderOptions: onDidChangeOptionsEmitter.event,

    provideChatSessionContent(
      resource: vscode.Uri,
      token: vscode.CancellationToken,
      providerContext: { readonly inputState: vscode.ChatSessionInputState },
    ): vscode.Thenable<vscode.ChatSession> {
      const sessionId = extractSessionId(resource);
      logger.appendLine(
        `[session-provider] provideChatSessionContent called for ${resource.toString()} (sessionId=${sessionId})`,
      );

      // Refresh option groups if they haven't been populated yet.
      // This handles the case where the backend wasn't running during
      // provider creation but is now available (user just selected the target).
      if (cachedOptionGroups.length === 0 && state.backend.isRunning()) {
        refreshOptionGroups().catch(() => { /* already logged */ });
      }

      // NOTE: Picker selection changes are handled by the ChatSessionItemController's
      // getChatSessionInputState → onDidChange subscription (set up above).
      // We no longer need to read inputState here — the controller keeps
      // state.currentAgent/currentModel updated in real-time.

      // New session — no history to restore
      // VSCode generates untitled-* URIs for fresh sessions; only real OpenCode
      // session IDs (e.g. from session.list()) should trigger history fetch.
      if (!sessionId || sessionId === 'new') {
        return {
          title: 'New OpenCode Session',
          history: [],
          requestHandler: createParticipantHandler(state),
        };
      }

      // For untitled-* sessions (VSCode-managed), look up the OpenCode session
      // that was previously created via requestHandler. The sessionMap key is
      // request.sessionId which matches the untitled-* ID from the URI path.
      if (sessionId.startsWith('untitled-')) {
        const chatState = state.sessionMap.get(sessionId);
        if (chatState?.opencodeSessionId) {
          logger.appendLine(
            `[session-provider] Found existing OpenCode session ${chatState.opencodeSessionId} for VSCode session ${sessionId}`,
          );

          // Fetch history from the OpenCode backend
          return (async (): Promise<vscode.ChatSession> => {
            try {
              const backendStatus = state.backend.getStatus();
              if (backendStatus !== 'running') {
                const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
                await state.backend.start(workspacePath);
              }

              const history = await fetchSessionHistory(chatState.opencodeSessionId, token);
              return {
                title: `OpenCode Session`,
                history,
                requestHandler: createParticipantHandler(state),
              };
            } catch (err) {
              logger.appendLine(
                `[session-provider] Failed to restore session history: ${err instanceof Error ? err.message : String(err)}`,
              );
              return {
                title: 'OpenCode Session',
                history: [],
                requestHandler: createParticipantHandler(state),
              };
            }
          })();
        }

        // No existing OpenCode session for this untitled tab — it's genuinely new
        return {
          title: 'New OpenCode Session',
          history: [],
          requestHandler: createParticipantHandler(state),
        };
      }

      // Existing session — fetch history from backend
      return (async (): Promise<vscode.ChatSession> => {
        try {
          // Ensure backend is running before fetching
          const backendStatus = state.backend.getStatus();
          if (backendStatus !== 'running') {
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
            await state.backend.start(workspacePath);
          }

          // Get session info for title
          const sessionInfo = await state.backend.sessions.get(sessionId);
          const title = sessionInfo.data?.title ?? `Session ${sessionId.slice(0, 8)}`;

          // Fetch message history
          const history = await fetchSessionHistory(sessionId, token);

          // Store in session map for request handler continuity
          const vscodeSessionKey = resource.toString();
          if (!state.sessionMap.has(vscodeSessionKey)) {
            state.sessionMap.set(vscodeSessionKey, {
              opencodeSessionId: sessionId,
              turnMap: [],
            });
          }

          return {
            title,
            history,
            requestHandler: createParticipantHandler(state),
          };
        } catch (err) {
          logger.appendLine(
            `[session-provider] Failed to fetch session history: ${err instanceof Error ? err.message : String(err)}`,
          );
          return {
            title: 'OpenCode (offline)',
            history: [],
            requestHandler: createParticipantHandler(state),
          };
        }
      })();
    },
  };

  return { provider, controller };
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

/**
 * Create a ChatRequestTurn for session history restoration.
 *
 * VSCode's stable types mark the constructor as @hidden/private, but the
 * proposed chatSessionsProvider API allows extensions to construct these objects.
 * We use a type-safe factory to avoid `as any` at call sites.
 */
function createRequestTurn(
  prompt: string,
  command: string | undefined,
  references: readonly vscode.ChatPromptReference[],
): vscode.ChatRequestTurn {
  // The proposed API exposes the constructor at runtime despite @types marking it private.
  const Ctor = vscode.ChatRequestTurn as unknown as new (
    p: string,
    c: string | undefined,
    r: readonly vscode.ChatPromptReference[],
  ) => vscode.ChatRequestTurn;
  return new Ctor(prompt, command, references);
}

/**
 * Create a ChatResponseTurn for session history restoration.
 */
function createResponseTurn(
  response: readonly vscode.ChatResponseMarkdownPart[],
  result: vscode.ChatResult,
): vscode.ChatResponseTurn {
  const Ctor = vscode.ChatResponseTurn as unknown as new (
    r: readonly vscode.ChatResponseMarkdownPart[],
    res: vscode.ChatResult,
  ) => vscode.ChatResponseTurn;
  return new Ctor(response, result);
}

function getTitle(state: { title?: string }): string | undefined {
  return state.title;
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
