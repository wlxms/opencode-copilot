import * as vscode from 'vscode';
import type {
  AcpEvent,
  AcpStreamPart,
  AcpTextPart,
  AcpReasoningPart,
  AcpToolPart,
  AcpStepPart,
  AcpToolState,
  AcpPartUpdatedEvent,
  AcpPartDeltaEvent,
  AcpSessionIdleEvent,
  AcpSessionDiffEvent,
  AcpFileDiff,
  AcpPermissionRequestEvent,
} from '../acp/types';
import type {
  ChatTerminalToolInvocationData,
  ChatSimpleToolResultData,
  ChatToolResourcesInvocationData,
  ChatSubagentToolInvocationData,
  ChatToolSpecificData,
  ChatToolInvocationPart,
  ChatToolInvocationStreamData,
  ChatWorkspaceFileEdit,
  ChatResponseDiffEntry,
  ChatResponseExternalEditPart,
  ChatResponseMultiDiffPart,
  ChatResponseWorkspaceEditPart,
} from '../types/vscode-proposed-additions';
import { ExternalEditTracker } from './external-edit-tracker';
import type { AcpEventStream } from '../acp/backend';
import { SubagentScope, formatSubagentProgress } from './subagent';

/** Extended stream with proposed API methods */
type Stream = vscode.ChatResponseStream & {
  thinkingProgress?(delta: { text?: string | string[]; id?: string; metadata?: { readonly [key: string]: unknown } }): void;
  beginToolInvocation?(callId: string, name: string, data?: ChatToolInvocationStreamData): void;
  updateToolInvocation?(callId: string, data: ChatToolInvocationStreamData): void;
};

type ProposedVscode = typeof vscode & {
  ChatToolInvocationPart?: new (
    toolName: string,
    toolCallId: string,
    errorMessage?: string,
  ) => ChatToolInvocationPart;
  ChatSubagentToolInvocationData?: new (
    description?: string,
    agentName?: string,
    prompt?: string,
    result?: string,
  ) => ChatSubagentToolInvocationData;
  ChatResponseExternalEditPart?: new (
    uris: readonly vscode.Uri[],
    callback: () => Thenable<unknown>,
  ) => ChatResponseExternalEditPart;
  ChatResponseWorkspaceEditPart?: new (
    edits: readonly ChatWorkspaceFileEdit[],
  ) => ChatResponseWorkspaceEditPart;
  ChatResponseMultiDiffPart?: new (
    value: ChatResponseDiffEntry[],
    title: string,
    readOnly?: boolean,
  ) => ChatResponseMultiDiffPart;
};

// Runtime access to proposed classes (may not exist)
const VS = vscode as ProposedVscode;

interface StreamBridgeLogger {
  appendLine(message: string): void;
}

interface StreamBridgeOptions {
  logger?: StreamBridgeLogger;
  sessionId?: string;
  /** URIs of files known to exist at the start of the turn */
  knownFileUris?: Set<string>;
  /** Per-edit tracker for externalEdit checkpoints */
  tracker?: ExternalEditTracker;
  /** Reply callback for permission.asked */
  replyToPermission?: (
    sessionId: string,
    permissionId: string,
    response: 'once' | 'always' | 'reject',
    directory?: string,
  ) => Promise<unknown>;
  /** Workspace directory for API calls */
  directory?: string;
  /** Check if any child sessions are still running (busy). Returns true if at least one child is busy. */
  checkChildSessionsRunning?: () => Promise<boolean>;
}

// =======================================================================
// StreamBridge
// =======================================================================

/**
 * Bridges OpenCode ACP events to a VSCode ChatResponseStream.
 *
 * Uses VSCode's proposed API (chatParticipantAdditions) for native rendering:
 * - stream.thinkingProgress()           → real-time thinking display
 * - stream.beginToolInvocation()         → streaming tool spinner
 * - ChatToolInvocationPart + toolSpecificData → rich expandable tool cards
 * - stream.markdown()                   → AI text token streaming
 *
 * toolSpecificData mapping (OpenCode tool → VSCode type):
 *   read          → ChatToolResourcesInvocationData (clickable file reference)
 *   bash          → ChatTerminalToolInvocationData (terminal UI with exit code)
 *   write         → ChatToolResourcesInvocationData (clickable file reference)
 *   edit          → ChatToolResourcesInvocationData (clickable file reference)
 *   list / grep   → ChatSimpleToolResultData (collapsible listing)
 *   task          → ChatSubagentToolInvocationData (click to expand subagent)
 *   (other)       → ChatSimpleToolResultData (generic fallback)
 */
export class StreamBridge {
  private userMessageId: string | null = null;
  private partKinds: Map<string, PartKind> = new Map();
  /** partID → toolCallID */
  private toolCallIds: Map<string, string> = new Map();
  /** callID → tool metadata accumulated during streaming */
  private toolMetas: Map<string, ToolMeta> = new Map();
  private hasThinking: boolean = false;
  private hasToolUI: boolean = false;
  private assistantPhaseStarted: boolean = false;
  /** Tracks which tool callIDs have received a progressive push (isComplete=false) part */
  private progressivePushed: Set<string> = new Set();
  /** Timestamp of last processed delta (for inter-delta gap measurement) */
  private lastDeltaTime: number = 0;
  /** Active subagent scopes — filters child events from rendering as independent cards */
  private activeSubagentScopes: Map<string, SubagentScope> = new Map();
  /** Whether at least one subagent (task) tool completed during this bridge session */
  private hadSubagentTasks = false;
  /** Whether a session.idle event was received (and deferred due to active subagents) */
  private deferredIdle = false;
  /** Safety timer: after deferred idle, stop waiting after this many ms of no events */
  private static readonly DEFERRED_IDLE_TIMEOUT_MS = 120_000;
  /** Timer handle for the deferred-idle safety timeout */
  private deferredIdleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Resolves when forceStop is triggered (deferred-idle timeout or external abort) */
  private forceStopResolve: (() => void) | null = null;
  private readonly logger?: StreamBridgeLogger;
  private readonly sessionId?: string;
  /** URIs of files that existed before the turn started (proactive baseline) */
  private knownFileUris: Set<string>;
  private readonly tracker?: ExternalEditTracker;
  private readonly replyToPermission?: StreamBridgeOptions['replyToPermission'];
  private readonly directory?: string;
  private readonly checkChildSessionsRunning?: StreamBridgeOptions['checkChildSessionsRunning'];

  constructor(options: StreamBridgeOptions = {}) {
    this.logger = options.logger;
    this.sessionId = options.sessionId;
    this.knownFileUris = options.knownFileUris ?? new Set();
    this.tracker = options.tracker;
    this.replyToPermission = options.replyToPermission;
    this.directory = options.directory;
    this.checkChildSessionsRunning = options.checkChildSessionsRunning;
  }

  /** Get the OpenCode message ID of the user message in this turn, if captured */
  getUserMessageId(): string | null {
    return this.userMessageId;
  }

  /** Whether at least one subagent (task) tool completed during this session.
   *  Set to true after a background task finishes; used by the handler to decide
   *  whether to send a continuation prompt after bridge stop. */
  getHadSubagentTasks(): boolean {
    return this.hadSubagentTasks;
  }

  /**
   * Primary bridge method: consume ACP events directly.
   *
   * @param events Async iterable of AcpEvent from the backend
   * @param stream VS Code ChatResponseStream for rendering
   * @param token Cancellation token
   * @returns true if the stream completed without cancellation
   */
   async run(
    events: AsyncIterable<AcpEvent>,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<boolean> {
    const s = stream as Stream;
    this.hasThinking = typeof s.thinkingProgress === 'function';
    this.hasToolUI = typeof s.beginToolInvocation === 'function';
    this.lastDeltaTime = 0;
    this.log(
      `bridge start: hasThinking=${this.hasThinking}, hasToolUI=${this.hasToolUI}, ` +
      `tokenCancelled=${token.isCancellationRequested}, targetSession=${this.sessionId ?? 'any'}`,
    );

    // Set up a force-stop mechanism for the deferred-idle safety timeout.
    // When the timer fires, it resolves this promise, which breaks the
    // for-await loop via Promise.race.
    let forceStopResolve: (() => void) | null = null;
    const forceStopPromise = new Promise<void>((resolve) => { forceStopResolve = resolve; });
    this.forceStopResolve = () => forceStopResolve?.();

    const iter = events[Symbol.asyncIterator]();

    try {
      while (true) {
        if (token.isCancellationRequested) {
          const msg = 'Operation cancelled';
          this.log('bridge stop: cancellation requested');
          stream.markdown(`\n⚠️ ${msg}\n`);
          break;
        }

        // Race between next event and force-stop signal
        const nextP = iter.next();
        const result = await Promise.race([
          nextP.then((r) => ({ event: r, stopped: false })),
          forceStopPromise.then(() => ({ event: null, stopped: true })),
        ]);

        if (result.stopped) {
          this.log('bridge stop: deferred idle timeout');
          break;
        }

        if (result.event) {
          const { value: event, done } = result.event;
          if (done) break;
          if (!event) break;

          const tEnter = Date.now();
          // Handle permission.asked as sync barrier (async, blocks loop until baseline captured + auto-reply)
          if (event.type === 'permission.asked') {
            await this.handlePermissionAsked(event, stream);
            const tPerm = Date.now();
            this.log(`[timing] permission.asked took ${tPerm - tEnter}ms`);
            continue;
          }
          const dispatched = this.processEvent(event, s);
          const tProcessed = Date.now();
          this.log(`[timing] processEvent: type=${event.type}, rendered=${dispatched.rendered}, took ${tProcessed - tEnter}ms`);
          if (dispatched.rendered) {
            await yieldToEventLoop();
            this.log(`[timing] yieldToEventLoop resolved, total=${Date.now() - tEnter}ms`);
          }
          if (dispatched.stop) {
            if (this.activeSubagentScopes.size > 0) {
              // Event stream ended while subagents were still active — log warning
              // but don't continue looping (the stream is exhausted).
              this.log(
                `bridge stop with ${this.activeSubagentScopes.size} leaked subagent scope(s): ` +
                [...this.activeSubagentScopes.keys()].join(', '),
              );
            } else {
              this.log('bridge stop: session.idle received');
            }
          break;
        }
      }
      this.log('bridge loop completed');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection lost';
      this.log(`bridge error: ${msg}`);
      stream.markdown(`\n⚠️ ${msg}\n`);
    } finally {
      this.log(
        `bridge reset: userMessageId=${this.userMessageId ?? 'null'}, ` +
        `partKinds=${this.partKinds.size}, toolMetas=${this.toolMetas.size}, ` +
        `subagentScopes=${this.activeSubagentScopes.size}`,
      );
      this.reset();
    }
    return !token.isCancellationRequested;
  }

  /**
   * @deprecated Use run() instead. Kept for backward compatibility with tests.
   */
  async bridgeEventsToStream(
    events: AcpEventStream,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<boolean> {
    return this.run(events.stream, stream, token);
  }

  // -------------------------------------------------------------------
  // Event dispatch
  // -------------------------------------------------------------------

  private processEvent(event: AcpEvent, stream: Stream): EventDispatchResult {
    this.log(`processEvent enter: type=${event.type}`);

    if (!this.shouldProcessEvent(event)) {
      const eventSessionId = getEventSessionId(event);
      this.log(
        `skip event: type=${event.type}, sessionID=${eventSessionId ?? 'unknown'}, ` +
        `target=${this.sessionId ?? 'any'}`,
      );
      return { stop: false, rendered: false };
    }

    // Handle forwarded child session events
    const eventSessionId = getEventSessionId(event);
    if (eventSessionId && eventSessionId !== this.sessionId) {
      // This event is from a child session (forwarded by event-broker)
      if (event.type === 'session.idle') {
        // Child session went idle — mark scope as truly complete
        for (const scope of this.activeSubagentScopes.values()) {
          if (scope.childSessionId === eventSessionId && !scope.childIdle) {
            scope.childIdle = true;
            this.log(`child session idle: childSessionId=${eventSessionId}, callID=${scope.callId}`);
            // If we were in deferred idle, check if ALL children are now idle
            if (this.deferredIdle) {
              const allChildrenIdle = [...this.activeSubagentScopes.values()]
                .filter(s => s.childSessionId)
                .every(s => s.childIdle);
              if (allChildrenIdle) {
                this.deferredIdle = false;
                this.clearDeferredIdleTimer();
                // Clean up child scopes to avoid "leaked scope" warning
                for (const [callId, s] of this.activeSubagentScopes) {
                  if (s.childIdle) this.activeSubagentScopes.delete(callId);
                }
                this.log('all child sessions idle — waiting for parent orchestrator to continue');
                return { stop: false, rendered: false };
              }
            }
            break;
          }
        }
      } else if (event.type === 'session.status') {
        // Child session status update — log but don't stop
        const statusEvent = event as any;
        this.log(`child session status: childSessionId=${eventSessionId}, status=${statusEvent.status?.type}`);
      } else if (event.type === 'part.updated' && event.part?.type === 'tool') {
        // Capture child/grandchild tool call for subagent progress display.
        // Push to ALL active scopes (matching by sessionId is unreliable because
        // childSessionId is set at task:completed, but child events arrive earlier).
        const childToolName = (event.part as any).toolName ?? 'unknown';
        const childState = (event.part as any).state;
        const childStatus = childState?.status ?? 'running';
        const childTitle = childState?.title;
        for (const scope of this.activeSubagentScopes.values()) {
          scope.toolCalls.push({
            name: childToolName,
            title: childTitle ?? undefined,
            status: childStatus,
          });
          // Update parent task tool card in real-time so subagent activity
          // appears inside the subagent card in VSCode chat.
          this.updateSubagentCard(stream, scope, childToolName, childTitle, childStatus);
        }
      }
      // Don't render child session events as parent events
      return { stop: false, rendered: false };
    }

    // Filter subagent-internal events: suppress rendering, capture for progress summary
    if (this.isSubagentInternalEvent(event)) {
      // Any subagent-internal event means the subagent is still active — reset safety timer
      if (this.deferredIdle) {
        this.resetDeferredIdleTimer();
      }
      this.captureSubagentEvent(event, stream);
      return { stop: false, rendered: false };
    }

    switch (event.type) {
      case 'part.updated':
        return { stop: false, rendered: this.handlePartUpdated(event, stream) };
      case 'part.delta':
        return { stop: false, rendered: this.handlePartDelta(event, stream) };
      case 'session.idle':
        // Don't stop while subagents are active — their completion events
        // haven't arrived yet and a premature break would lose them.
        if (this.activeSubagentScopes.size > 0) {
          const hasUncompleted = [...this.activeSubagentScopes.values()].some(s => !s.completed);
          if (!hasUncompleted) {
            // All subagent scopes are completed (parent dispatched all tasks).
            // But background child sessions may still be running — poll them.
            this.checkChildSessionsAndMaybeStop();
            return { stop: false, rendered: false };
          }
          // At least one subagent is still running — defer idle
          this.deferredIdle = true;
          this.startDeferredIdleTimer();
          this.log(
            `session.idle deferred: ${this.activeSubagentScopes.size} subagent(s), ` +
            `${[...this.activeSubagentScopes.values()].filter(s => !s.completed).length} still running, ` +
            `timeout=${StreamBridge.DEFERRED_IDLE_TIMEOUT_MS / 1000}s`,
          );
          return { stop: false, rendered: false };
        }
        return { stop: true, rendered: false };
      case 'session.diff':
        return { stop: false, rendered: this.handleSessionDiff(event, stream) };
      // permission.asked is handled directly in run() (async)
      case 'permission.asked':
        return { stop: false, rendered: false };
    }
    return { stop: false, rendered: false };
  }

  private shouldProcessEvent(evt: AcpEvent): boolean {
    if (!this.sessionId) return true;

    switch (evt.type) {
      case 'part.updated':
      case 'part.delta': {
        const eventSessionId = getEventSessionId(evt);
        if (!eventSessionId || eventSessionId === this.sessionId) return true;
        // Allow child session events if they belong to an active subagent scope
        if (this.isChildSessionEvent(eventSessionId)) return true;
        return false;
      }
      // session.idle and session.status from child sessions should be processed
      // (they're forwarded by the broker for completion detection)
      case 'session.idle':
      case 'session.status':
        return true;
      default:
        return true;
    }
  }

  // -------------------------------------------------------------------
  // permission.asked — sync barrier for per-edit externalEdit
  // -------------------------------------------------------------------

  private async handlePermissionAsked(event: AcpPermissionRequestEvent, stream: vscode.ChatResponseStream): Promise<boolean> {
    const callID = event.tool?.callId;
    const filepath = event.metadata?.filepath as string | undefined;
    const sessionId = event.sessionId;
    const permissionId = event.permissionId;

    this.log(
      `permission.asked: id=${permissionId}, callID=${callID ?? 'none'}, ` +
      `filepath=${filepath ?? 'none'}, sessionID=${sessionId ?? 'none'}`,
    );

    // If we have a tracker and this is an edit-related permission with a file path, track it
    if (this.tracker && callID && filepath) {
      // Normalize URI to match VSCode's internal casing (lowercase drive letter on Windows).
      const rawUri = vscode.Uri.file(filepath);
      const normalizedPath = rawUri.path.replace(/^\/([A-Z]):\//, (_match, drive) => `/${drive.toLowerCase()}:`);
      const fileUri = rawUri.path !== normalizedPath
        ? rawUri.with({ path: normalizedPath })
        : rawUri;

      // Skip if this callID is already tracked, or if the file already has an active
      // ExternalEditPart (VSCode only supports one per file at a time).
      if (this.tracker.hasEdit(callID)) {
        this.log(`trackEdit skipped — callID=${callID} already tracked`);
      } else if (this.tracker.isTrackingAny([fileUri])) {
        this.log(`trackEdit skipped — file ${filepath} already has an active edit, callID=${callID}`);
      } else {
        try {
          await this.tracker.trackEdit(callID, [fileUri], stream);
          this.log(`trackEdit resolved for callID=${callID} — baseline captured`);
        } catch (err) {
          this.log(`trackEdit failed for callID=${callID}: ${err}`);
        }
      }
    }

    // Auto-reply "once" to resume the server
    if (this.replyToPermission && sessionId && permissionId) {
      try {
        await this.replyToPermission(sessionId, permissionId, 'once', this.directory);
        this.log(`auto-replied 'once' for permission ${permissionId}`);
      } catch (err) {
        this.log(`auto-reply failed for permission ${permissionId}: ${err}`);
      }
    }

    return false; // no visual rendering needed
  }

  // -------------------------------------------------------------------
  // part.updated
  // -------------------------------------------------------------------

  private handlePartUpdated(event: AcpPartUpdatedEvent, stream: Stream): boolean {
    const part = event.part;
    if (!part) return false;

    this.log(`part.updated: partType=${part.type} id=${part.id} messageId=${part.messageId ?? 'unknown'}`);

    switch (part.type) {
      case 'text': {
        const textPart = part as AcpTextPart;
        const msgId = textPart.messageId;
        if (!this.assistantPhaseStarted && !this.userMessageId && textPart.text && textPart.text.length > 0 && msgId) {
          this.userMessageId = msgId;
          this.log(`captured userMessageId=${msgId}`);
          return false;
        }
        if (msgId !== this.userMessageId || !this.userMessageId) {
          this.partKinds.set(textPart.id, 'text');
          this.log(`registered text part id=${textPart.id}, messageId=${msgId ?? 'none'}`);
        }
        return false;
      }
      case 'reasoning': {
        this.assistantPhaseStarted = true;
        const reasoningPart = part as AcpReasoningPart;
        this.partKinds.set(reasoningPart.id, 'reasoning');
        return false;
      }
      case 'tool': {
        this.assistantPhaseStarted = true;
        const toolPart = part as AcpToolPart;
        this.partKinds.set(toolPart.id, 'tool');
        return this.handleToolState(toolPart, stream);
      }
      case 'step-start':
      case 'step-finish': {
        this.assistantPhaseStarted = true;
        return false;
      }
    }

    return false;
  }

  // -------------------------------------------------------------------
  // part.delta
  // -------------------------------------------------------------------

  private handlePartDelta(
    event: AcpPartDeltaEvent,
    stream: Stream,
  ): boolean {
    if (!event.delta) return false;

    const partID = event.partId;
    const delta = event.delta;
    const kind = this.partKinds.get(partID);
    const now = Date.now();
    const gap = this.lastDeltaTime ? now - this.lastDeltaTime : 0;
    this.lastDeltaTime = now;
    this.log(`part.delta: partID=${partID}, kind=${kind ?? 'unknown'}, len=${delta.length}, gap=${gap}ms`);

    if (kind === 'reasoning') {
      if (this.hasThinking && stream.thinkingProgress) {
        stream.thinkingProgress({ text: delta, id: partID });
        return true;
      }
    } else if (kind === 'text') {
      stream.markdown(delta);
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------
  // session.diff → ChatResponseMultiDiffPart (shows +/- lines in UI)
  // -------------------------------------------------------------------

  private handleSessionDiff(event: AcpSessionDiffEvent, stream: Stream): boolean {
    const diffs = event.diffs;
    if (!diffs?.length) return false;

    if (!VS.ChatResponseMultiDiffPart || !stream.push) {
      return false;
    }

    const entries: ChatResponseDiffEntry[] = diffs
      .filter((d) => d.status !== 'deleted')
      .map((d) => {
        const uri = vscode.Uri.file(d.file);
        const entry: ChatResponseDiffEntry = {
          modifiedUri: uri,
          added: d.additions || undefined,
          removed: d.deletions || undefined,
        };
        if (d.status !== 'added') {
          entry.originalUri = uri;
        }
        return entry;
      });

    if (!entries.length) return false;

    try {
      const diffPart = new VS.ChatResponseMultiDiffPart(entries, 'File Changes', true);
      stream.push(diffPart as unknown as vscode.ChatResponsePart);
      this.log(`pushed MultiDiffPart: ${entries.length} file(s) changed`);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------
  // Tool call state machine: pending → running → completed
  // -------------------------------------------------------------------

  private handleToolState(part: AcpToolPart, stream: Stream): boolean {
    const state = part.state;
    if (!state) return false;

    const toolName = part.toolName ?? 'unknown';
    const callID = part.callId ?? part.id;
    const status = state.status;
    this.log(`tool.state: tool=${toolName}, callID=${callID}, status=${status}`);

    if (status === 'pending') {
      // --- TOOL STARTED ---
      this.toolCallIds.set(part.id, callID);
      this.toolMetas.set(callID, {
        name: toolName,
        input: undefined,
        output: undefined,
        title: undefined,
        timeStart: undefined,
        timeEnd: undefined,
      });

      if (this.hasToolUI && stream.beginToolInvocation) {
        stream.beginToolInvocation(callID, toolName);
      } else {
        stream.progress(`🔧 ${toolName}...`);
      }
      return true;
    }

    if (status === 'running') {
      // --- TOOL RUNNING (has input) ---
      const meta = this.toolMetas.get(callID);
      if (meta) {
        meta.input = state.input ?? {};
        meta.title = getToolTitle(state);
        meta.timeStart = getToolTime(state)?.start;
      }
      // Track subagent scope so child events get filtered instead of leaking
      if (toolName === 'task' || toolName === 'subagent') {
        this.activeSubagentScopes.set(callID, {
          callId: callID,
          toolCalls: [],
          completed: false,
        });
        this.log(`subagent scope opened: callID=${callID}`);
      }
      if (this.hasToolUI && stream.updateToolInvocation) {
        stream.updateToolInvocation(callID, {
          partialInput: state.input ?? {},
        });
        // Progressive push: push ChatToolInvocationPart with isComplete=false
        // to show the "tool running" spinner in VSCode UI.
        // The part will be updated/overwritten when completed status arrives.
        if (VS.ChatToolInvocationPart && stream.push && !this.progressivePushed.has(callID)) {
          try {
            const part: ChatToolInvocationPart = new VS.ChatToolInvocationPart(toolName, callID);
            part.isComplete = false;
            part.isError = false;
            part.enablePartialUpdate = true;
            part.invocationMessage = this.formatInvocationMsg(
              toolName,
              state.input ?? {},
              getToolTitle(state) ?? toolName,
            );
            stream.push(part as unknown as vscode.ChatResponsePart);
            this.progressivePushed.add(callID);
          } catch {
            // Progressive push is best-effort; existing updateToolInvocation is sufficient
          }
        }
        return true;
      }
      return true;
    }

    if (status === 'completed') {
      // --- TOOL COMPLETED ---
      const meta = this.toolMetas.get(callID);
      if (meta) {
        meta.output = getToolOutput(state) ?? '';
        meta.timeEnd = getToolTime(state)?.end;
        meta.title = getToolTitle(state) ?? meta.title;
      }

      // For subagent tools: inject aggregated progress into output before rendering.
      // IMPORTANT: do NOT delete the scope here. For background tasks, the parent
      // session marks the tool call "completed" as soon as the task is *dispatched*,
      // but the subagent continues running asynchronously.  The scope must stay open
      // so that deferredIdle keeps the bridge alive and late-arriving subagent
      // events are still captured for progress.
      const subagentScope = this.activeSubagentScopes.get(callID);
      if ((toolName === 'task' || toolName === 'subagent') && subagentScope) {
        // Extract child session ID from tool metadata (OpenCode task tool puts it there)
        const childSessionId = (state.metadata?.sessionId ??
          (typeof state.output === 'string' ? state.output.match(/task_id:\s*(\S+)/)?.[1] : undefined)) as string | undefined;
        if (childSessionId) {
          subagentScope.childSessionId = childSessionId;
          this.log(`child session ID captured: callID=${callID}, childSessionId=${childSessionId}`);
        }
        const progress = formatSubagentProgress(subagentScope);
        if (progress && meta) {
          meta.output = [progress, meta.output].filter(Boolean).join('\n');
        }
        subagentScope.completed = true;
        this.hadSubagentTasks = true;
        this.log(`subagent scope completed (kept open): callID=${callID}, progress="${progress}"`);
      }

      // Build and push ChatToolInvocationPart
      if (this.hasToolUI && VS.ChatToolInvocationPart) {
        this.pushToolInvocation(stream, callID, toolName, state);
      } else {
        this.renderToolFallback(
          stream,
          toolName,
          state.input,
          getToolOutput(state),
          getToolTitle(state),
        );
      }
      // Track new file creation via ChatResponseWorkspaceEditPart
      if (toolName === 'write' && VS.ChatResponseWorkspaceEditPart && stream.push) {
        const input = state.input as Record<string, unknown> | undefined;
        const filePath = input?.filePath as string | undefined;
        if (filePath) {
          const fileUri = vscode.Uri.file(filePath).toString();
          const isNewFile = !this.knownFileUris.has(fileUri);
          if (isNewFile) {
            try {
              const editPart = new VS.ChatResponseWorkspaceEditPart([
                { newResource: vscode.Uri.file(filePath) },
              ]);
              stream.push(editPart as unknown as vscode.ChatResponsePart);
              this.log(`pushed WorkspaceEditPart for new file: ${filePath}`);
            } catch {
              // Best-effort; checkpoint still works via externalEdit baseline
            }
          }
        }
      }
      // Best-effort diagnostic: log when edit/write touches files outside the proactive set
      if ((toolName === 'edit' || toolName === 'write') && this.knownFileUris.size > 0) {
        const input = state.input as Record<string, unknown> | undefined;
        const filePath = input?.filePath as string | undefined;
        if (filePath) {
          const fileUri = vscode.Uri.file(filePath).toString();
          if (!this.knownFileUris.has(fileUri)) {
            this.log(`tool ${toolName} touched file not in proactive set: ${filePath} (best-effort tracking)`);
          }
        }
      }
      this.toolMetas.delete(callID);
      this.toolCallIds.delete(part.id);

      // Complete the per-edit externalEdit checkpoint for this tool call
      if (this.tracker) {
        this.tracker.completeEdit(callID);
        this.log(`completeEdit called for callID=${callID}`);
      }

      return true;
    }

    if (status === 'error') {
      // Clean up subagent scope on error
      if (toolName === 'task' || toolName === 'subagent') {
        this.activeSubagentScopes.delete(callID);
      }
      // Try to push ChatToolInvocationPart with isError=true
      if (this.hasToolUI && VS.ChatToolInvocationPart) {
        this.pushToolInvocation(stream, callID, toolName, state, true);
      } else {
        this.renderToolFallback(
          stream,
          toolName,
          state.input,
          state.error,
          getToolTitle(state) ?? toolName,
        );
      }
      this.toolMetas.delete(callID);
      this.toolCallIds.delete(part.id);
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------
  // Push ChatToolInvocationPart with appropriate toolSpecificData
  // -------------------------------------------------------------------

  private pushToolInvocation(
    stream: Stream,
    callID: string,
    toolName: string,
    state: AcpToolState,
    isError?: boolean,
  ): void {
    try {
      const meta = this.toolMetas.get(callID);
      const title = getToolTitle(state) ?? meta?.title ?? toolName;
      const input = state.input ?? meta?.input ?? {};
      const output = getToolOutput(state) ?? meta?.output ?? '';
      const time = getToolTime(state);
      const timeStart = time?.start ?? meta?.timeStart;
      const timeEnd = time?.end ?? meta?.timeEnd;

      const ChatToolInvocationPartCtor = VS.ChatToolInvocationPart;
      if (!ChatToolInvocationPartCtor) {
        throw new Error('ChatToolInvocationPart unavailable');
      }

      const part: ChatToolInvocationPart = new ChatToolInvocationPartCtor(
        toolName,
        callID,
      );

      if (isError) {
        // Error state: show error styling with invocation message
        part.isError = true;
        part.invocationMessage = state.status === 'error' && state.error
          ? state.error
          : `Tool ${toolName} failed`;
        // No pastTenseMessage or toolSpecificData for errors
      } else {
        // Success/complete state
        part.enablePartialUpdate = true;
        part.isComplete = true;
        part.invocationMessage = this.formatInvocationMsg(toolName, input, title);
        part.pastTenseMessage = this.formatPastTenseMsg(toolName, title, timeStart, timeEnd);

        // Select and attach the appropriate toolSpecificData
        part.toolSpecificData = this.buildToolSpecificData(
          toolName, title, input, output, timeStart, timeEnd,
        );
      }

      // Hide internal/structural tools after completion
      if (toolName === 'internal' || toolName === 'step-start' || toolName === 'step-finish') {
        part.presentation = 'hiddenAfterComplete';
      }

      stream.push(part as unknown as vscode.ChatResponsePart);
    } catch {
      this.renderToolFallback(
        stream,
        toolName,
        state.input,
        getToolOutput(state),
        getToolTitle(state),
      );
    }
  }

  // -------------------------------------------------------------------
  // Build toolSpecificData based on tool name
  // -------------------------------------------------------------------

  private buildToolSpecificData(
    toolName: string,
    title: string,
    input: Record<string, unknown>,
    output: string,
    timeStart?: number,
    timeEnd?: number,
  ): ChatToolSpecificData | undefined {
    switch (toolName) {
      case 'bash':
      case 'shell': {
        const lang = input.language as string
          ?? detectLanguage(title)
          ?? 'bash';
        return {
          commandLine: {
            original: (input.command as string) ?? title,
          },
          language: lang,
          output: output ? { text: output } : undefined,
          state:
            timeStart != null
              ? { duration: timeEnd != null ? timeEnd - timeStart : undefined }
              : undefined,
        } satisfies ChatTerminalToolInvocationData;
        }

      case 'read': {
        // Show as file reference so the chat panel displays a clickable file URI
        const filePath = input.filePath as string | undefined;
        if (filePath) {
          return {
            values: [vscode.Uri.file(filePath)],
          } satisfies ChatToolResourcesInvocationData;
        }
        return {
          input: formatInput(input, title),
          output: truncate(output, 2000),
        } satisfies ChatSimpleToolResultData;
      }

      case 'write':
      case 'edit': {
        // Show as file reference if filePath is available
        const filePath = input.filePath as string | undefined;
        if (filePath) {
          return {
            values: [vscode.Uri.file(filePath)],
          } satisfies ChatToolResourcesInvocationData;
        }
        return {
          input: formatInput(input, title),
          output: truncate(output, 2000),
        } satisfies ChatSimpleToolResultData;
      }

      case 'list':
      case 'grep': {
        return {
          input: formatInput(input, title),
          output: truncate(output, 2000),
        } satisfies ChatSimpleToolResultData;
      }

      case 'task':
      case 'subagent': {
        const description = (input.description as string) ?? title;
        const agentName = (input.agentName as string) ?? toolName;
        const prompt = (input.prompt as string) ?? formatInput(input, '');
        const result = truncate(output, 4000);
        // Use ChatSubagentToolInvocationData constructor if available at runtime
        if (VS.ChatSubagentToolInvocationData) {
          return new VS.ChatSubagentToolInvocationData(
            description,
            agentName,
            prompt,
            result,
          ) as ChatSubagentToolInvocationData satisfies ChatSubagentToolInvocationData;
        }
        return {
          description,
          agentName,
          prompt,
          result,
        } satisfies ChatSubagentToolInvocationData;
      }

      default:
        // Generic fallback
        if (Object.keys(input).length > 0 || output) {
          return {
            input: formatInput(input, title),
            output: truncate(output, 2000),
          } satisfies ChatSimpleToolResultData;
        }
        return undefined;
    }
  }

  // -------------------------------------------------------------------
  // Message formatting
  // -------------------------------------------------------------------

  private formatInvocationMsg(
    toolName: string,
    input: Record<string, unknown>,
    title: string,
  ): string {
    const display = title || toolName;
    if (!input || Object.keys(input).length === 0) {
      return `Running ${display}`;
    }
    const firstKey = Object.keys(input)[0];
    const firstVal = input[firstKey];
    const short = typeof firstVal === 'string'
      ? firstVal.length > 60 ? firstVal.substring(0, 57) + '...' : firstVal
      : JSON.stringify(firstVal);
    return `Running ${display} (${firstKey}: ${short})`;
  }

  private formatPastTenseMsg(
    toolName: string,
    title: string,
    timeStart?: number,
    timeEnd?: number,
  ): string {
    const display = title || toolName;
    const pastVerb = { read: 'Read', bash: 'Ran', write: 'Wrote', list: 'Listed', grep: 'Searched', edit: 'Edited', task: 'Completed subagent' }[toolName] ?? 'Executed';
    let msg = `${pastVerb} ${display}`;
    if (timeStart != null && timeEnd != null) {
      const dur = ((timeEnd - timeStart) / 1000).toFixed(1);
      msg += ` (${dur}s)`;
    }
    return msg;
  }

  // -------------------------------------------------------------------
  // Markdown fallback (no proposed API)
  // -------------------------------------------------------------------

  private renderToolFallback(
    stream: Stream,
    toolName: string,
    input: Record<string, unknown> | undefined,
    output: string | undefined,
    title?: string,
  ): void {
    const display = title ?? toolName;
    const inputLine = input && Object.keys(input).length > 0
      ? Object.entries(input)
        .map(([k, v]) => `**${k}**: \`${typeof v === 'string' ? v : JSON.stringify(v)}\``)
        .join(', ')
      : '';

    stream.markdown(`\n🔧 **${display}** \`${toolName}\``);
    if (inputLine) stream.markdown(` — ${inputLine}`);
    if (output) {
      stream.markdown(`\n\`\`\`\n${truncate(output, 300)}\n\`\`\`\n`);
    }
    stream.markdown('\n');
  }

  // -------------------------------------------------------------------
  // Subagent scope filtering
  // -------------------------------------------------------------------

  /**
   * Check whether an event belongs to an active subagent's internal stream.
   *
   * Strategy: `partKinds` acts as a whitelist of known parent parts. Any
   * `part.updated` or `part.delta` referencing an unregistered partId while
   * a subagent scope is active is treated as a subagent-internal event.
   *
   * Exception: top-level structural part types (text, reasoning, step-start,
   * step-finish) are NEVER subagent-internal — they belong to the parent turn
   * and may arrive after the subagent scope opens (e.g. a second step that
   * starts while the subagent is still running).
   */
  private isSubagentInternalEvent(event: AcpEvent): boolean {
    if (this.activeSubagentScopes.size === 0) return false;

    if (event.type === 'part.updated') {
      const part = event.part;
      if (!part) return false;
      // Structural parent parts are never subagent-internal
      if (part.type === 'text' || part.type === 'reasoning' ||
          part.type === 'step-start' || part.type === 'step-finish') {
        return false;
      }
      // Parent-level task/subagent tool invocations are NOT subagent-internal.
      // Without this, a second parallel task tool would be captured instead of rendered.
      if (part.type === 'tool') {
        const toolName = (part as AcpToolPart).toolName;
        if (toolName === 'task' || toolName === 'subagent') return false;
      }
      // Already-known parent part → not subagent
      if (this.partKinds.has(part.id)) return false;
      // New part during active subagent → subagent internal
      return true;
    }

    if (event.type === 'part.delta') {
      // Unregistered part during active subagent → subagent delta
      return !this.partKinds.has(event.partId);
    }

    return false;
  }

  /** Returns true if the given sessionId matches any active subagent scope's childSessionId. */
  private isChildSessionEvent(sessionId: string): boolean {
    for (const scope of this.activeSubagentScopes.values()) {
      if (scope.childSessionId === sessionId) return true;
    }
    return false;
  }

  /**
   * Push a real-time invocation message update to the parent task tool card
   * so subagent activity (reads, edits, bash commands) is visible inside the
   * subagent card in VSCode chat while the subagent runs.
   */
  private updateSubagentCard(
    stream: Stream,
    scope: SubagentScope,
    toolName: string,
    title: string | undefined,
    status: string,
  ): void {
    if (!this.hasToolUI || !stream.updateToolInvocation) return;

    const label = title ?? toolName;
    const verb = status === 'completed' ? '✓' : status === 'error' ? '✗' : '⋯';
    const msg = `${verb} ${toolName}: ${label}`;
    try {
      stream.updateToolInvocation(scope.callId, { invocationMessage: msg });
    } catch {
      // updateToolInvocation is best-effort; the progress summary on completion is the fallback
    }
  }

  /**
   * Capture a subagent-internal event for progress aggregation.
   * Only tool events are tracked (for the summary like "3 reads, 2 edits").
   * Also pushes real-time invocation message updates to the parent task tool card.
   */
  private captureSubagentEvent(event: AcpEvent, stream?: Stream): void {
    if (event.type !== 'part.updated' || !event.part) return;
    if (event.part.type !== 'tool') return;

    const toolPart = event.part as AcpToolPart;
    const state = toolPart.state;
    if (!state) return;

    const toolName = toolPart.toolName ?? 'unknown';
    const title = state.title;

    // Record into all active scopes (typically just one)
    for (const scope of this.activeSubagentScopes.values()) {
      scope.toolCalls.push({
        name: toolName,
        title: title ?? undefined,
        status: state.status,
      });
      // Update parent task tool card so subagent activity is visible in chat
      if (stream) {
        this.updateSubagentCard(stream, scope, toolName, title, state.status);
      }
    }

    this.log(
      `subagent capture: tool=${toolName}, status=${state.status}, ` +
      `activeScopes=${this.activeSubagentScopes.size}`,
    );
  }

  private reset(): void {
    // userMessageId intentionally NOT reset — caller reads it after bridging
    this.partKinds.clear();
    this.toolCallIds.clear();
    this.toolMetas.clear();
    this.progressivePushed.clear();
    this.activeSubagentScopes.clear();
    this.deferredIdle = false;
    this.clearDeferredIdleTimer();
    this.forceStopResolve = null;
    this.assistantPhaseStarted = false;
  }

  // -------------------------------------------------------------------
  // Deferred idle safety timer
  // -------------------------------------------------------------------

  /**
   * Start a safety timeout. If no subagent events arrive before it fires,
   * the bridge stops to avoid hanging indefinitely.
   */
  private startDeferredIdleTimer(): void {
    this.clearDeferredIdleTimer();
    this.deferredIdleTimer = setTimeout(() => {
      this.log(
        `deferred idle timeout fired (${StreamBridge.DEFERRED_IDLE_TIMEOUT_MS / 1000}s) — ` +
        `closing ${this.activeSubagentScopes.size} remaining subagent scope(s)`,
      );
      this.activeSubagentScopes.clear();
      this.deferredIdleTimer = null;
      // Break the while-loop in run() by resolving the force-stop promise
      this.forceStopResolve?.();
    }, StreamBridge.DEFERRED_IDLE_TIMEOUT_MS);
  }

  /** Reset the timer (called when a subagent-internal event arrives after deferred idle). */
  private resetDeferredIdleTimer(): void {
    if (this.deferredIdle && this.deferredIdleTimer) {
      this.startDeferredIdleTimer();
    }
  }

  private clearDeferredIdleTimer(): void {
    if (this.deferredIdleTimer) {
      clearTimeout(this.deferredIdleTimer);
      this.deferredIdleTimer = null;
    }
  }

  /** Break the while-loop in run() by resolving the force-stop promise. */
  private requestStop(): void {
    if (this.forceStopResolve) {
      this.forceStopResolve();
      this.forceStopResolve = null;
    }
  }

  /**
   * When parent session.idle arrives and all subagent scopes are completed
   * (i.e. the parent dispatched all tasks), we need to verify that the
   * background child sessions are actually done before stopping the bridge.
   *
   * Uses the `checkChildSessionsRunning` callback (which polls the SDK
   * session.children + session.status APIs) to detect busy children.
   */
  private checkChildSessionsAndMaybeStop(): void {
    if (!this.checkChildSessionsRunning) {
      // No polling callback available — fall back to immediate stop
      this.clearDeferredIdleTimer();
      this.log('bridge stop: all subagents completed (no child polling callback)');
      this.requestStop();
      return;
    }

    this.deferredIdle = true;
    this.startDeferredIdleTimer();
    this.log('session.idle deferred: checking child sessions in 2s');

    // Poll child sessions after a short delay
    const pollTimer = setTimeout(async () => {
      try {
        const childrenRunning = await this.checkChildSessionsRunning();
        if (!childrenRunning) {
          this.deferredIdle = false;
          this.clearDeferredIdleTimer();
          this.log('all child sessions idle (via poll) — waiting for parent orchestrator to continue');
        } else {
          this.log('child sessions still running, polling again in 3s');
          // Schedule another poll — replace the safety timer
          this.checkChildSessionsAndMaybeStop();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`child session poll error: ${msg}, stopping bridge`);
        this.clearDeferredIdleTimer();
        this.requestStop();
      }
    }, 2000);

    // Track timer so clearDeferredIdleTimer can cancel it
    if (this.deferredIdleTimer !== null) {
      clearTimeout(this.deferredIdleTimer);
    }
    this.deferredIdleTimer = pollTimer;
  }

  private log(message: string): void {
    this.logger?.appendLine(`[streaming] ${message}`);
  }
}

// =======================================================================
// Helpers
// =======================================================================

type PartKind = 'reasoning' | 'text' | 'tool';

interface EventDispatchResult {
  stop: boolean;
  rendered: boolean;
}

interface ToolMeta {
  name: string;
  input: Record<string, unknown> | undefined;
  output: string | undefined;
  title: string | undefined;
  timeStart: number | undefined;
  timeEnd: number | undefined;
}

/** Truncate text to maxLen characters, appending '…' if truncated */
function truncate(text: string, maxLen: number): string {
  if (!text || text.length <= maxLen) return text;
  return text.substring(0, maxLen) + '…';
}

/** Format tool input as a human-readable string */
function formatInput(input: Record<string, unknown>, fallback: string): string {
  if (!input || Object.keys(input).length === 0) return fallback;
  return Object.entries(input)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
}

/** Heuristic language detection from tool title */
function detectLanguage(title: string): string {
  const m = title.match(/\.(\w+)$/);
  if (m) {
    const ext = m[1];
    const map: Record<string, string> = { sh: 'bash', py: 'python', js: 'javascript', ts: 'typescript', ps1: 'powershell', rb: 'ruby', go: 'go', rs: 'rust', java: 'java' };
    return map[ext] ?? ext;
  }
  return 'bash';
}

function getToolTitle(state: AcpToolState): string | undefined {
  return state.title;
}

function getToolOutput(state: AcpToolState): string | undefined {
  return state.output;
}

function getToolTime(
  state: AcpToolState,
): { start?: number; end?: number } | undefined {
  if (state.startTime != null || state.endTime != null) {
    return { start: state.startTime, end: state.endTime };
  }
  return undefined;
}

function getEventSessionId(evt: AcpEvent): string | undefined {
  switch (evt.type) {
    case 'part.updated':
      return evt.part?.sessionId;
    case 'session.idle':
    case 'session.status':
      return evt.sessionId;
    case 'session.created':
    case 'session.updated':
    case 'session.deleted':
      return evt.sessionId;
    default:
      return undefined;
  }
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
