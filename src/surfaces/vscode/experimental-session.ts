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
 * │  + optional optionGroups (agent picker)     │
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
import type { AcpEvent } from '../../acp/types';
import type { AcpEventStream } from '../../acp/backend';
import { createParticipantHandler } from '../../participant/handler';
import { isUserSelectableAgent } from '../../acp/types';


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

import { CollectorStream } from '../../acp/streaming/collector-stream';
import { readSessionEvents } from '../../acp/serializable/serializer';
import { readCheckpoints } from '../../acp/checkpoint/checkpoint-store';

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
  processEvent(evt: AcpEvent): void {
    switch (evt.type) {
      case 'part.updated':
        this.handlePartUpdated(evt);
        break;
      case 'part.delta':
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

  private handlePartUpdated(evt: AcpEvent): void {
    if (evt.type !== 'part.updated') {return;}
    const part = evt.part;
    if (!part) {return;}

    switch (part.type) {
      case 'reasoning':
        this.currentFrame.hasReasoning = true;
        break;
      case 'tool':
        this.handleToolState({
          callID: part.callId,
          tool: part.toolName,
          state: part.state as { status: string; input?: Record<string, unknown>; output?: string; title?: string; error?: string; startTime?: number; endTime?: number },
        });
        break;
    }
  }

  private handlePartDelta(evt: AcpEvent): void {
    if (evt.type !== 'part.delta') {return;}
    const delta = evt.delta;
    if (!delta) {return;}

    // We don't track part kinds here (that's the renderer's job).
    // For structured content, we accumulate into the current frame.
    if (this.currentFrame.hasReasoning) {
      this.currentFrame.reasoningText =
        (this.currentFrame.reasoningText ?? '') + delta;
    } else {
      this.currentFrame.markdown =
        (this.currentFrame.markdown ?? '') + delta;
    }
  }

  private handleSessionDiff(evt: AcpEvent): void {
    if (evt.type !== 'session.diff') {return;}
    const diffs = evt.diffs;
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

function getWorkspaceDirectory(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
}

function createSessionResource(sessionId: string): vscode.Uri {
  return vscode.Uri.parse(`${OPENCODE_SESSION_SCHEME}:/${sessionId}`);
}

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
 * 3. We subscribe to `onDidChange` → parse groups → update selection via state.selection.setAgent
 * 4. Handler reads state.selection.get() at prompt time
 *
 * @param state - The global extension state.
 * @param context - The extension context (for subscriptions).
 * @returns Object with `provider` (ChatSessionContentProvider) and
 *          `controller` (ChatSessionItemController), both ready for registration.
 */
/**
 * Returns true if `title` is a placeholder/auto-generated session title
 * that carries no meaningful information (e.g. "New OpenCode Session",
 * "OpenCode Session abc", "Session abc", or empty).
 */
export function isPlaceholderSessionTitle(title: string | undefined): boolean {
  const normalized = title?.trim() ?? '';
  return !normalized
    || normalized === 'New OpenCode Session'
    || normalized.startsWith('OpenCode Session ')
    || normalized.startsWith('Session ');
}

export function createSessionContentProvider(
  state: ExtensionState,
  context: vscode.ExtensionContext,
): {
  provider: vscode.ChatSessionContentProvider;
  controller: vscode.ChatSessionItemController | undefined;
} {
  const logger = state.outputChannel;
  const directory = getWorkspaceDirectory();

  // ── Local session cache ──────────────────────────────────────────────
  const SESSION_CACHE_KEY = 'acp.sessionItems';
  interface CachedSessionItem { id: string; title: string; createdAt: number; }

  // Guard against concurrent refreshSessionItems() calls that can race
  // when both the handler post-turn and VS Code's refreshHandler fire
  // simultaneously, causing controller.items.replace() to overwrite a
  // complete list with a partial one.
  let sessionRefreshInFlight = false;

  // -- Option Groups: Agent picker ----------------------------------------

  const onDidChangeOptionsEmitter = new vscode.EventEmitter<void>();
  let cachedOptionGroups: vscode.ChatSessionProviderOptionGroup[] = [];
  /** Guard against re-entrant refreshOptionGroups() calls (e.g. event fire → VSCode re-query loop) */
  let optionGroupsRefreshInFlight: Promise<void> | null = null;
  /**
   * Reference to the most recently created inputState.
   * VSCode's provideChatSessionProviderOptions only affects NEW sessions;
   * to update the picker text in an ALREADY-OPEN session we must push
   * new groups into the existing inputState object directly.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let currentInputState: any = undefined;

  /** Placeholder option groups shown while the backend is not yet running */
  function buildConnectingOptionGroups(): vscode.ChatSessionProviderOptionGroup[] {
    return [
      {
        id: 'agents',
        name: 'Agent',
        items: [{ id: 'agent-connecting', name: '--', description: 'Waiting for backend' }],
        selected: { id: 'agent-connecting', name: '--', description: 'Waiting for backend' },
      },
    ];
  }

  /** Check whether cached option groups are still placeholder/stub groups */
  function isPlaceholderGroups(groups: vscode.ChatSessionProviderOptionGroup[]): boolean {
    return groups.length > 0 && (groups[0]?.selected?.id?.endsWith('-connecting') ?? false);
  }

  /** Build option groups from backend config */
  async function refreshOptionGroups(): Promise<void> {
    // Guard: if a refresh is already in-flight, return the existing promise.
    // This prevents re-entrant loops where provideChatSessionProviderOptions
    // calls refreshOptionGroups → onDidChangeOptionsEmitter.fire() →
    // VSCode re-calls provideChatSessionProviderOptions → refreshOptionGroups.
    if (optionGroupsRefreshInFlight) {
      return optionGroupsRefreshInFlight;
    }

    optionGroupsRefreshInFlight = doRefreshOptionGroups();
    try {
      await optionGroupsRefreshInFlight;
    } finally {
      optionGroupsRefreshInFlight = null;
    }
  }

  /** Actual work — separated so the guard can deduplicate calls */
  async function doRefreshOptionGroups(): Promise<void> {
    try {
      // If backend is not running, show placeholder groups without calling backend
      if (!state.backend.isRunning()) {
        const prevGroups = cachedOptionGroups;
        cachedOptionGroups = buildConnectingOptionGroups();
        // Only fire event if groups actually changed (avoid re-triggering VSCode re-poll)
        if (prevGroups !== cachedOptionGroups) {
          onDidChangeOptionsEmitter.fire();
        }
        logger.appendLine('[session-provider] Backend not running — showing "Connecting…" option groups');
        return;
      }

      logger.appendLine(`[session-provider] Refreshing option groups (backend running=true)...`);

      // Fetch agents (model selection is delegated to VS Code's native model picker)
      const agentsResult = await state.backend.config.agents(directory);

      const agents = (agentsResult.data ?? []).filter((a: { hidden?: boolean; mode?: string }) => isUserSelectableAgent(a as any));

      logger.appendLine(
        `[session-provider] Backend returned: ${agentsResult.data?.length ?? 0} agents (error=${agentsResult.error ?? 'none'})`,
      );

      const sel = state.selection.get();

      // Build agent option items
      const agentItems: vscode.ChatSessionProviderOptionItem[] = (agents as any[]).map((a: any) => ({
        id: `agent-${a.id}`,
        name: a.name ?? a.id,
        description: a.description,
        default: a.id === sel.agent,
      }));

      // Find selected agent item
      const currentAgentId = sel.agent;
      const selectedAgent = agentItems.find(i => i.id === `agent-${currentAgentId}`) ?? agentItems[0];

      cachedOptionGroups = [
        ...(agentItems.length > 0 ? [{
          id: 'agents',
          name: 'Agent',
          items: agentItems,
          selected: selectedAgent,
        }] : []),
      ];

      onDidChangeOptionsEmitter.fire();
      logger.appendLine(
        `[session-provider] Option groups refreshed: ${agentItems.length} agents`,
      );
    } catch (err) {
      logger.appendLine(
        `[session-provider] Failed to refresh option groups: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function ensureBackendRunning(): Promise<void> {
    if (state.backend.getStatus() === 'running') {
      return;
    }

    const result = await state.backend.start(directory);
    if (result.error) {
      throw new Error(typeof result.error === 'string' ? result.error : 'Failed to start backend');
    }
  }

  function createSessionLabelFromPrompt(prompt: string | undefined, sessionId: string): string {
    const normalized = (prompt ?? '').replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return `Session ${sessionId.slice(0, 8)}`;
    }

    return normalized.length > 60 ? `${normalized.slice(0, 57).trimEnd()}…` : normalized;
  }

  function getHistoryDerivedSessionTitle(
    history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[],
    sessionId: string,
  ): string {
    const firstRequest = history.find(
      (turn): turn is vscode.ChatRequestTurn => turn instanceof vscode.ChatRequestTurn,
    );
    return createSessionLabelFromPrompt(firstRequest?.prompt, sessionId);
  }

  function collectRuntimeSessions(): Array<{ id: string; title: string; createdAt: Date }> {
    const runtimeSessions = new Map<string, { id: string; title: string; createdAt: Date }>();

    for (const chatState of state.sessions.values()) {
      if (!chatState.sessionId) {
        continue;
      }

      const existing = runtimeSessions.get(chatState.sessionId);
      const newTitle = chatState.title ?? '';

      // Prefer non-placeholder titles when multiple sessionMap entries share
      // the same sessionId (e.g. untitled-N vs opencode-copilot.opencode:/ses_xxx).
      if (existing) {
        const existingIsPlaceholder = isPlaceholderSessionTitle(existing.title);
        const newIsPlaceholder = isPlaceholderSessionTitle(newTitle);
        if (existingIsPlaceholder && !newIsPlaceholder) {
          runtimeSessions.set(chatState.sessionId, {
            id: chatState.sessionId,
            title: newTitle,
            createdAt: chatState.createdAt ?? existing.createdAt,
          });
        }
      } else {
        runtimeSessions.set(chatState.sessionId, {
          id: chatState.sessionId,
          title: newTitle,
          createdAt: chatState.createdAt ?? new Date(),
        });
      }
    }

    return Array.from(runtimeSessions.values());
  }

  function getSessionLabel(session: { title: string; id: string }): string {
    const title = session.title.trim();
    return title.length > 0 ? title : `Session ${session.id.slice(0, 8)}`;
  }

  function getSessionDescription(_session: { id: string; title: string }): string | undefined {
    return undefined;
  }

  function mergeSessions(
    listedSessions: readonly { id: string; title: string; createdAt: Date }[],
    runtimeSessions: readonly { id: string; title: string; createdAt: Date }[],
  ): Array<{ id: string; title: string; createdAt: Date }> {
    const merged = new Map<string, { id: string; title: string; createdAt: Date }>();

    for (const session of listedSessions) {
      merged.set(session.id, session);
    }

    for (const session of runtimeSessions) {
      const existing = merged.get(session.id);
      if (!existing) {
        merged.set(session.id, session);
        continue;
      }

      merged.set(session.id, {
        id: session.id,
        title: !isPlaceholderSessionTitle(existing.title) ? existing.title : session.title,
        createdAt: existing.createdAt ?? session.createdAt,
      });
    }

    return Array.from(merged.values()).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  function publishSessionItems(controller: vscode.ChatSessionItemController, sessions: readonly { id: string; title: string; createdAt: Date }[]): void {
    const sessionThemeIcon = new vscode.ThemeIcon('opencode-logo');
    const items = sessions.map((session) => {
      const resource = createSessionResource(session.id);
      const item = controller.createChatSessionItem(resource, getSessionLabel(session));
      item.iconPath = sessionThemeIcon;
      item.description = getSessionDescription(session);
      item.status = vscode.ChatSessionStatus.Completed;
      item.timing = { created: session.createdAt.getTime() };
      item.tooltip = session.id;
      return item;
    });

    controller.items.replace(items);
    logger.appendLine(`[session-provider] Published ${items.length} session item(s) to Session list`);

    try {
      const cached: CachedSessionItem[] = sessions.map(s => ({
        id: s.id, title: s.title, createdAt: s.createdAt.getTime(),
      }));
      context.globalState.update(SESSION_CACHE_KEY, cached);
    } catch { /* non-critical */ }
  }

  async function refreshSessionItems(): Promise<void> {
    if (!controller) {
      return;
    }

    // Skip session list refresh when backend is not running.
    // This preserves VSCode's default session list (user can navigate back)
    // instead of replacing it with an empty list.
    if (!state.backend.isRunning()) {
      logger.appendLine('[session-provider] Backend not running — skipping session list refresh');
      return;
    }

    // ---- Re-entrancy guard ----
    // refreshSessionItems() can be called from multiple sources concurrently
    // (onBackendReady, handler post-turn, VS Code refreshHandler).  If a
    // refresh is already in-flight, skip this call — the in-flight call will
    // publish the correct list.  We note the race so the cache-as-floor
    // protection below knows to supplement from cache.
    const isRace = sessionRefreshInFlight;
    if (isRace) {
      logger.appendLine('[session-provider] Refresh already in-flight — deferring to prior call');
    }

    sessionRefreshInFlight = true;
    try {
      // Use filesystem-backed SessionStore (single source of truth)
      const sessions = await state.sessionStore.listSessions();

      logger.appendLine(
        `[session-provider] Refreshing Session list from SessionStore (count=${sessions.length})`,
      );

      const items = sessions.map(s => ({
        id: s.id,
        title: s.title ?? s.id,
        createdAt: new Date(s.createdAt ?? Date.now()),
      }));

      publishSessionItems(controller, items);
    } finally {
      sessionRefreshInFlight = false;
    }
  }

  // Kick off initial option groups load (non-blocking).
  // When backend is not running this will show "Connecting…" placeholders.
  // When backend IS already running this will populate real data.
  refreshOptionGroups().catch(err => {
    logger.appendLine(`[session-provider] Initial option groups load failed: ${err}`);
  });

  // Register a one-shot callback so that when the backend finishes starting,
  // we immediately refresh option groups + session list with real data.
  // This avoids polling: no repeated requests while backend is offline.
  const onBackendReadyHandler = () => {
    logger.appendLine('[session-provider] Backend ready — refreshing option groups and session list');
    refreshOptionGroups().catch(err => {
      logger.appendLine(`[session-provider] Backend-ready option groups refresh failed: ${err}`);
    });
    refreshSessionItems().catch(err => {
      logger.appendLine(
        `[session-provider] Backend-ready session list refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };
  const backendReadyDispose = state.bus.on('backend-ready', onBackendReadyHandler);

  // -- ChatSessionItemController: Picker Tracking --------------------------
  // The controller creates tracked inputState objects via createChatSessionInputState().
  // VSCode monitors these objects, so onDidChange actually fires when the user
  // changes picker selections. Without the controller, inputState.onDidChange
  // is dead (VSCode only tracks inputStates from controllers).

  const chat = vscode.chat as Record<string, unknown>;
  const hasControllerAPI = typeof chat.createChatSessionItemController === 'function';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let controller: vscode.ChatSessionItemController | undefined;
  let sessionListChangedDispose: (() => void) | undefined;

  if (hasControllerAPI) {
    controller = (vscode.chat as any).createChatSessionItemController(
      OPENCODE_SESSION_SCHEME,
      async (_token: vscode.CancellationToken) => {
        await Promise.all([
          refreshOptionGroups(),
          refreshSessionItems().catch((err) => {
            logger.appendLine(
              `[session-provider] Session item refresh failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            // Do NOT replace items with [] — that wipes VSCode's default
            // session list and traps the user in an empty view. The
            // onBackendReady callback will populate items once the backend
            // is available.
          }),
        ]);
      },
    ) as vscode.ChatSessionItemController;

    sessionListChangedDispose = state.bus.on('session-list-changed', () => {
      refreshSessionItems().catch((err) => {
        logger.appendLine(
          `[session-provider] Session list refresh on event failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });

    controller.getChatSessionInputState = (
      _sessionResource: vscode.Uri | undefined,
      _context: { readonly previousInputState: vscode.ChatSessionInputState | undefined },
      _token: vscode.CancellationToken,
    ): vscode.ChatSessionInputState => {
      // Create a tracked inputState from our option groups.
      // VSCode monitors this object — when the user changes a picker selection,
      // onDidChange fires on the returned inputState.
      const inputState = controller!.createChatSessionInputState(cachedOptionGroups);

      // Keep a reference so we can push group updates to an already-open session
      // when the backend connects (VSCode won't re-query a live inputState).
      currentInputState = inputState;

      // Listen for option-group refreshes and push new groups into
      // this inputState so the picker text updates in real time.
      const syncListener = onDidChangeOptionsEmitter.event(() => {
        if (currentInputState && !isPlaceholderGroups(cachedOptionGroups)) {
          // [debug] logger.appendLine('[session-provider] Pushing updated groups to current inputState');
          currentInputState.groups = cachedOptionGroups;
        }
      });

      // Subscribe to changes — update selection in real-time.
      inputState.onDidChange(() => {
        const groups = inputState.groups ?? [];
        // [debug] logger.appendLine(
        //   `[session-provider] Picker changed: ${groups.length} groups` +
        //   groups.map(g => ` [${g.id}] selected=${g.selected?.id ?? '(none)'}`).join(''),
        // );

        for (const group of groups) {
          const selected = group.selected;
          if (!selected) { continue; }

          // Skip placeholder items — they shouldn't leak into state
          if (selected.id.endsWith('-connecting')) {
            // [debug] logger.appendLine(`[session-provider] Picker ignored placeholder selection: ${selected.id}`);
            continue;
          }

          if (group.id === 'agents') {
            const agentId = selected.id.replace(/^agent-/, '');
            state.selection.setAgent(agentId).catch((err: unknown) => {
              logger.appendLine(`[session-provider] Failed to set agent: ${err}`);
            });
            // [debug] logger.appendLine(`[session-provider] Picker set currentAgent=${agentId}`);
          }
        }
      });

      inputState.onDidDispose(() => {
        logger.appendLine(`[session-provider] InputState disposed for ${_sessionResource?.toString() ?? 'new session'}`);
        syncListener.dispose();
        if (currentInputState === inputState) {
          currentInputState = undefined;
        }
      });

      return inputState;
    };

    logger.appendLine(`[session-provider] ChatSessionItemController created (id=${controller.id})`);

    // -- forkHandler: enables edit/rewind/fork UI buttons in the chat view ------
    // Without this, VS Code sets hasForkHandler=false which hides the fork UI.
    // This handler creates a child session and registers it as a new session item.
    controller.forkHandler = createForkHandler(controller);

  } else {
    logger.appendLine('[session-provider] ChatSessionItemController API not available — picker changes will NOT propagate');
  }

  // Session-level forkHandler: attached to every ChatSession returned by
  // provideChatSessionContent() so VSCode shows edit/rewind/fork buttons
  // for sessions loaded through the session target (including untitled sessions
  // that have no ChatSessionItem in the controller's item list).
  const sessionForkHandler = controller?.forkHandler;

  context.subscriptions.push({
    dispose: () => {
      backendReadyDispose();
      sessionListChangedDispose?.();
    },
  });

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
   * Resolve the real OpenCode session ID from a session resource URI.
   *
   * For untitled sessions, the URI contains the VSCode-generated ID (e.g.
   * "untitled-xxx") which must be mapped to the OpenCode session ID via
   * `state.sessions`. For real sessions (from the session list), the URI
   * already contains the OpenCode session ID.
   */
  function resolveOpenCodeSessionId(sessionResource: vscode.Uri): string | undefined {
    const rawId = extractSessionId(sessionResource);

    // Real OpenCode session IDs (from session.list) are used directly
    if (rawId && !rawId.startsWith('untitled-') && rawId !== 'new') {
      return rawId;
    }

    // Untitled sessions: look up the OpenCode session ID via sessions
    if (rawId) {
      const chatState = state.sessions.get(rawId);
      if (chatState?.sessionId) {
        return chatState.sessionId;
      }

      // Also check by the full URI string (sessionResource-based keys)
      const uriKey = sessionResource.toString();
      const uriState = state.sessions.get(uriKey);
      if (uriState?.sessionId) {
        return uriState.sessionId;
      }
    }

    return undefined;
  }

  /**
   * Create a forkHandler function for use by both the ChatSessionItemController
   * and the ChatSession objects returned by provideChatSessionContent().
   *
   * The handler resolves the correct OpenCode session ID (mapping VSCode untitled
   * IDs to backend session IDs), creates a child session, and registers it as a
   * new session item in the controller.
   */
  function createForkHandler(
    ctrl: vscode.ChatSessionItemController,
  ): ((
    sessionResource: vscode.Uri,
    request: vscode.ChatRequestTurn | undefined,
    _token: vscode.CancellationToken,
  ) => Promise<vscode.ChatSessionItem>) {
    return async (
      sessionResource: vscode.Uri,
      request: vscode.ChatRequestTurn | undefined,
      _token: vscode.CancellationToken,
    ): Promise<vscode.ChatSessionItem> => {
      const rawSessionId = extractSessionId(sessionResource);
      const sessionId = resolveOpenCodeSessionId(sessionResource);

      const derivedLabel = request?.prompt
        ? `Fork: ${request.prompt.slice(0, 40).trimEnd()}`
        : 'Forked Session';
      const title = derivedLabel.length > 0 ? derivedLabel : 'Forked Session';

      logger.appendLine(
        `[session-provider] Fork requested for raw=${rawSessionId}, backend=${sessionId ?? 'unknown'} (title="${title}")`,
      );

      if (!sessionId) {
        const msg = `Cannot fork session: unable to resolve OpenCode session ID for resource ${sessionResource.toString()}`;
        logger.appendLine(`[session-provider] ${msg}`);
        throw new Error(msg);
      }

      const result = await state.backend.sessions.create({
        parentId: sessionId,
        directory,
        title,
      });

      if (result.error || !result.data?.id) {
        const msg = `Failed to create forked session: ${result.error ?? 'no id'}`;
        logger.appendLine(`[session-provider] ${msg}`);
        throw new Error(msg);
      }

      const newSessionId = result.data.id;
      const newResource = createSessionResource(newSessionId);

      const item = ctrl.createChatSessionItem(newResource, getSessionLabel({ id: newSessionId, title }));
      item.status = vscode.ChatSessionStatus.Completed;
      item.timing = { created: Date.now() };
      ctrl.items.add(item);

      logger.appendLine(
        `[session-provider] Forked session ${newSessionId} created from ${sessionId}`,
      );

      // Refresh the session list so the new forked session appears
      refreshSessionItems().catch(() => {});

      return item;
    };
  }

  /**
   * Fetch message history from the backend and map to VSCode turn format.
   *
   * Replays persisted ACP events through a CollectorStream + bridge instead of
   * fetching from the backend API directly. This ensures the restored session
   * matches the original rendering exactly.
   */
  async function fetchSessionHistory(
    sessionId: string,
    token: vscode.CancellationToken,
  ): Promise<(vscode.ChatRequestTurn | vscode.ChatResponseTurn)[]> {
    const turnsPath = state.sessionStore.getTurnsPath(sessionId);
    const sessionDir = state.sessionStore.getSessionDir(sessionId);

    // 1. Read events and snapshots
    const events = await readSessionEvents<AcpEvent>(turnsPath);
    const snapshots = await readCheckpoints(sessionDir);

    logger.appendLine(
      `[session-provider] fetchSessionHistory: read ${events.length} events + ${snapshots.length} snapshots from ${turnsPath}`,
    );

    if (events.length === 0) {
      return [];
    }

    // 2. Create CollectorStream for replay
    const collector = new CollectorStream();

    // 3. Create bridge via backend factory (same factory used for live rendering)
    const bridge = state.backend.createBridge(sessionId);
    bridge.setStream(collector);

    // 4. Replay events
    let userTurn: vscode.ChatRequestTurn | null = null;

    for (const event of events) {
      if (token.isCancellationRequested) break;

      // Detect user message from the first text event
      if (event.type === 'part.updated' && event.part.type === 'text' && !userTurn) {
        const textPart = event.part as { text?: string };
        if (textPart.text && textPart.text.length > 0) {
          userTurn = new (vscode.ChatRequestTurn as unknown as new (
            prompt: string, command: string | undefined, references: unknown[], participant: string
          ) => vscode.ChatRequestTurn)(
            textPart.text,
            undefined,
            [],
            'opencode-copilot.opencode',
          );
        }
        // Don't replay the user message as assistant output
        continue;
      }

      // Replay event through bridge → CollectorStream captures rendered output
      bridge.processEvent(event);
    }

    // 5. Build turn from captured parts
    const assistantTurn = collector.buildTurn();

    const history: (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[] = [];
    if (userTurn) {
      history.push(userTurn);
    }
    history.push(assistantTurn);

    logger.appendLine(
      `[session-provider] Restored ${history.length} turns for session ${sessionId}`,
    );

    return history;
  }

  // -- The Provider --------------------------------------------------------
  // Following the Copilot CLI pattern: the session provider only provides content
  // (history, title) and manages option groups (agent picker).
  // All request handling is delegated to the same ChatParticipant handler used
  // by the stable surface (participant/handler.ts), ensuring a shared session
  // lifecycle. Picker changes update selection via the
  // controller's tracked inputState.onDidChange, and the handler reads from
  // state at prompt time.

  const provider: vscode.ChatSessionContentProvider = {
    /**
      * Called by VSCode at registration time and whenever
      * onDidChangeChatSessionProviderOptions fires.
      * Returns the option groups (agent picker).
     */
    provideChatSessionProviderOptions(
      _token: vscode.CancellationToken,
    ): Thenable<vscode.ChatSessionProviderOptions> {
      // If we have real data cached, return immediately.
      if (cachedOptionGroups.length > 0 && !isPlaceholderGroups(cachedOptionGroups)) {
        return Promise.resolve({ optionGroups: cachedOptionGroups });
      }

      // If a refresh is already in-flight, return the in-flight promise.
      // This prevents re-entrant loops where fire() → VSCode re-query → refresh again.
      if (optionGroupsRefreshInFlight) {
        return optionGroupsRefreshInFlight.then(() => ({
          optionGroups: cachedOptionGroups,
        }));
      }

      // Backend might be running now — if so, fetch real data.
      // If still offline, refreshOptionGroups() returns placeholders.
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
    ): Thenable<vscode.ChatSession> {
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
      // selection updated in real-time.

      // New session — no history to restore
      // VSCode generates untitled-* URIs for fresh sessions; only real OpenCode
      // session IDs (e.g. from session.list()) should trigger history fetch.
      if (!sessionId || sessionId === 'new') {
        return Promise.resolve({
          title: 'New OpenCode Session',
          history: [],
          requestHandler: createParticipantHandler(state),
          ...(sessionForkHandler ? { forkHandler: sessionForkHandler } : {}),
        });
      }

      // For untitled-* sessions (VSCode-managed), look up the OpenCode session
      // that was previously created via requestHandler. The sessions key is
      // request.sessionId which matches the untitled-* ID from the URI path.
      if (sessionId.startsWith('untitled-')) {
        const chatState = state.sessions.get(sessionId);
        if (chatState?.sessionId) {
          logger.appendLine(
            `[session-provider] Found existing OpenCode session ${chatState.sessionId} for VSCode session ${sessionId}`,
          );

          // Fetch history from the OpenCode backend
          return (async (): Promise<vscode.ChatSession> => {
            try {
              await ensureBackendRunning();

              const history = await fetchSessionHistory(chatState.sessionId, token);

              // Determine title with priority:
              // 1. Non-placeholder chatState title (already fetched from backend earlier)
              // 2. Backend-generated title (fetch fresh in case it was generated after last update)
              // 3. History-derived fallback
              let title: string;
              if (!isPlaceholderSessionTitle(chatState.title) && chatState.title?.trim()) {
                title = chatState.title.trim();
              } else {
                // Try fetching the latest title from backend — it may have been
                // auto-generated after the first response completed.
                try {
                  const sessionInfo = await state.backend.sessions.get(chatState.sessionId);
                  const backendTitle = sessionInfo.data?.title?.trim() ?? '';
                  if (!isPlaceholderSessionTitle(backendTitle)) {
                    title = backendTitle;
                    // Persist to sessions so subsequent tab switches skip the fetch
                    chatState.title = backendTitle;
                  } else {
                    title = getHistoryDerivedSessionTitle(history, chatState.sessionId);
                  }
                } catch {
                  title = getHistoryDerivedSessionTitle(history, chatState.sessionId);
                }
              }

              return {
                title,
                history,
                requestHandler: createParticipantHandler(state),
                ...(sessionForkHandler ? { forkHandler: sessionForkHandler } : {}),
              };
            } catch (err) {
              logger.appendLine(
                `[session-provider] Failed to restore session history: ${err instanceof Error ? err.message : String(err)}`,
              );
              return {
                title: chatState.title?.trim() || 'OpenCode (offline)',
                history: [],
                requestHandler: createParticipantHandler(state),
                ...(sessionForkHandler ? { forkHandler: sessionForkHandler } : {}),
              };
            }
          })();
        }

        // No existing OpenCode session for this untitled tab — it's genuinely new
        return Promise.resolve({
          title: 'New OpenCode Session',
          history: [],
          requestHandler: createParticipantHandler(state),
          ...(sessionForkHandler ? { forkHandler: sessionForkHandler } : {}),
        });
      }

      // Existing session — fetch history from backend
      return (async (): Promise<vscode.ChatSession> => {
        try {
          await ensureBackendRunning();

          // Get session info for title
          const sessionInfo = await state.backend.sessions.get(sessionId);

          // Fetch message history
          const history = await fetchSessionHistory(sessionId, token);
          const backendTitle = sessionInfo.data?.title?.trim() ?? '';
          // Use backend title only if it's a meaningful (non-placeholder) title;
          // otherwise derive from the first user message in history.
          const title = !isPlaceholderSessionTitle(backendTitle)
            ? backendTitle
            : getHistoryDerivedSessionTitle(history, sessionId);

          // Store in session map for request handler continuity
          const vscodeSessionKey = resource.toString();
          const existingState = state.sessions.get(vscodeSessionKey);
          let bestTitle = title;
          if (existingState) {
            existingState.sessionId = sessionId;
            if (!existingState.title?.trim() || isPlaceholderSessionTitle(existingState.title)) {
              existingState.title = title;
            }
            bestTitle = existingState.title;
            existingState.createdAt = sessionInfo.data?.createdAt ?? existingState.createdAt ?? new Date();
          } else {
            // Before creating a new entry with a potentially placeholder title,
            // check if any other sessions entry for the same sessionId
            // already has a non-placeholder title (from a previous handler run).
            if (isPlaceholderSessionTitle(title)) {
              for (const cs of state.sessions.values()) {
                if (cs.sessionId === sessionId && !isPlaceholderSessionTitle(cs.title)) {
                  bestTitle = cs.title ?? bestTitle;
                  break;
                }
              }
            }
            state.sessions.set(vscodeSessionKey, {
              sessionId: sessionId,
              turnMap: [],
              title: bestTitle,
              createdAt: sessionInfo.data?.createdAt ?? new Date(),
            });
          }

          return {
            title: bestTitle,
            history,
            requestHandler: createParticipantHandler(state),
            ...(sessionForkHandler ? { forkHandler: sessionForkHandler } : {}),
          };
        } catch (err) {
          logger.appendLine(
            `[session-provider] Failed to fetch session history: ${err instanceof Error ? err.message : String(err)}`,
          );
          return {
            title: 'OpenCode (offline)',
            history: [],
            requestHandler: createParticipantHandler(state),
            ...(sessionForkHandler ? { forkHandler: sessionForkHandler } : {}),
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
  eventStream: AcpEventStream,
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

      const rawEvtTyped = rawEvt as AcpEvent;

      // Render to the live stream (uses proposed APIs if available)
      const result = renderer.renderEvent(rawEvtTyped, stream);

      // Also capture as structured content
      session.processEvent(rawEvtTyped);

      if (result.rendered) {
        await yieldToEventLoop();
      }

      if (rawEvtTyped.type === 'session.idle') {
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
 * The participant ID used to construct ChatRequestTurn / ChatResponseTurn
 * objects. Must match the ID passed to `vscode.chat.createChatParticipant()`.
 */
const PARTICIPANT_ID = 'opencode-copilot.opencode';

/**
 * Create a ChatRequestTurn for session history restoration.
 *
 * VSCode's internal ChatRequestTurn constructor requires 5 arguments:
 *   (prompt, command, references, participant, toolReferences)
 * The stable @types/vscode hides the constructor, but the proposed
 * chatSessionsProvider API permits construction at runtime.
 */
function createRequestTurn(
  prompt: string,
  command: string | undefined,
  references: readonly vscode.ChatPromptReference[],
): vscode.ChatRequestTurn {
  const Ctor = vscode.ChatRequestTurn as unknown as new (
    p: string,
    c: string | undefined,
    r: readonly vscode.ChatPromptReference[],
    participant: string,
    toolReferences: readonly vscode.ChatLanguageModelToolReference[],
  ) => vscode.ChatRequestTurn;
  return new Ctor(prompt, command, references, PARTICIPANT_ID, []);
}

/**
 * Create a ChatResponseTurn for session history restoration.
 *
 * VSCode's internal ChatResponseTurn constructor requires 3–4 arguments:
 *   (response, result, participant, command?)
 * Missing the `participant` parameter causes VS Code to reject or silently
 * drop the turn during rendering.
 */
function createResponseTurn(
  response: readonly vscode.ChatResponseMarkdownPart[],
  result: vscode.ChatResult,
): vscode.ChatResponseTurn {
  const Ctor = vscode.ChatResponseTurn as unknown as new (
    r: readonly vscode.ChatResponseMarkdownPart[],
    res: vscode.ChatResult,
    participant: string,
    command?: string,
  ) => vscode.ChatResponseTurn;
  return new Ctor(response, result, PARTICIPANT_ID);
}

function getTitle(state: { title?: string }): string | undefined {
  return state.title;
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
