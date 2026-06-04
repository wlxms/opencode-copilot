/**
 * OpenCodeBridge — bridges ACP events to a VS Code ChatResponseStream.
 *
 * Implements the AcpBridge interface for both live streaming and session
 * restore (replay). The same bridge handles both paths:
 *
 * == Live path ==
 *   Call setStream(stream), setTracker(tracker), setCallbacks(callbacks),
 *   then await run(events, token). After each processed event the bridge
 *   invokes callbacks.onEvent(event) so the caller can persist events.
 *
 * == Replay path ==
 *   Call setStream(collectorStream), then processEvent(event) for each
 *   persisted event. The collector stream captures rendered parts.
 *
 * Uses VSCode's proposed API (chatParticipantAdditions) for native rendering:
 * - stream.thinkingProgress()           → real-time thinking display
 * - stream.beginToolInvocation()        → streaming tool spinner
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

import * as vscode from 'vscode';
import type {
  AcpEvent,
  AcpResult,
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
  AcpQuestionRequestEvent,
  AcpSessionLifecycleEvent,
  AcpSessionStatus,
  AcpChildSessionInfo,
} from '../../acp/types';
import type {
  ChatTerminalToolInvocationData,
  ChatSimpleToolResultData,
  ChatToolResourcesInvocationData,
  ChatSubagentToolInvocationData,
  ChatTodoToolInvocationData,
  ChatToolSpecificData,
  ChatToolInvocationPart,
  ChatToolInvocationStreamData,
  ChatWorkspaceFileEdit,
  ChatResponseDiffEntry,
  ChatResponseExternalEditPart,
  ChatResponseMultiDiffPart,
  ChatResponseWorkspaceEditPart,
} from '../../types/vscode-proposed-additions';
import { ChatTodoStatus, ChatQuestion, ChatQuestionType } from '../../types/vscode-proposed-additions';
import { type ExternalEditTracker } from '../../participant/external-edit-tracker';
import type { AcpEventStream } from '../../acp/backend';
import type {
  AcpBridge,
  AcpSessionOperations,
  AcpPermissionOperations,
  AcpQuestionOperations,
  StreamingBridgeCallbacks,
} from '../../acp/backend';
import { type SubagentScope, formatSubagentProgress } from '../../participant/subagent';

/** Extended stream with proposed API methods */
type Stream = vscode.ChatResponseStream & {
  thinkingProgress?(delta: { text?: string | string[]; id?: string; metadata?: { readonly [key: string]: unknown } }): void;
  beginToolInvocation?(callId: string, name: string, data?: ChatToolInvocationStreamData): void;
  updateToolInvocation?(callId: string, data: ChatToolInvocationStreamData): void;
  questionCarousel?(questions: ChatQuestion[], allowSkip?: boolean): Thenable<Record<string, unknown> | undefined>;
  /** Proposed API: push a ChatResponsePart directly to the stream */
  push?(part: unknown): void;
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

// =======================================================================
// OpenCodeBridge
// =======================================================================

/**
 * Bridges OpenCode ACP events to a VSCode ChatResponseStream.
 *
 * Implements {@link AcpBridge} for both live streaming and session replay.
 * Backend sub-interfaces (`sessions`, `permissions`, `questions`) are
 * injected directly rather than wrapped in callback options.
 */
export class OpenCodeBridge implements AcpBridge {
  private stream?: Stream;
  private callbacks?: StreamingBridgeCallbacks;
  private tracker?: ExternalEditTracker;
  private userMessageId: string | null = null;
  private partKinds: Map<string, PartKind> = new Map();
  private editCounter: number = 0;
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
  /** Backend-generated session title captured from session.updated events */
  private sessionTitle: string | undefined;
  private hadSubagentTasks = false;
  /** Whether a session.idle event was received (and deferred due to active subagents) */
  private deferredIdle = false;
  /** Safety timer: after deferred idle, stop waiting after this many ms of no events */
  private static readonly DEFERRED_IDLE_TIMEOUT_MS = 120_000;
  /** Timer handle for the deferred-idle safety timeout */
  private deferredIdleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Resolves when forceStop is triggered (deferred-idle timeout or external abort) */
  private forceStopResolve: (() => void) | null = null;
  private readonly log: (message: string) => void;
  private sessionId?: string;
  /** URIs of files that existed before the turn started (proactive baseline) */
  private knownFileUris: Set<string>;
  private readonly directory?: string;

  constructor(
    private readonly sessions?: AcpSessionOperations,
    private readonly permissions?: AcpPermissionOperations,
    private readonly questions?: AcpQuestionOperations,
    options?: {
      logger?: StreamBridgeLogger;
      sessionId?: string;
      /** URIs of files known to exist at the start of the turn */
      knownFileUris?: Set<string>;
      /** Workspace directory for API calls */
      directory?: string;
    },
  ) {
    this.sessionId = options?.sessionId;
    this.knownFileUris = options?.knownFileUris ?? new Set();
    this.directory = options?.directory;
    this.log = options?.logger
      ? (msg: string) => options.logger!.appendLine(`[streaming] ${msg}`)
      : () => {};
  }

  /** Tagged log — prefixes message with [tag] for filtering (e.g. [tool], [delta], [subagent]). */
  private logTag(tag: string, message: string): void {
    this.log(`[${tag}] ${message}`);
  }

  // -------------------------------------------------------------------
  // AcpBridge interface
  // -------------------------------------------------------------------

  /** @inheritdoc */
  setStream(stream: unknown): void {
    this.stream = stream as Stream;
    this.hasThinking = typeof (stream as Stream).thinkingProgress === 'function';
    this.hasToolUI = typeof (stream as Stream).beginToolInvocation === 'function';
  }

  /** @inheritdoc */
  setCallbacks(callbacks: StreamingBridgeCallbacks): void {
    this.callbacks = callbacks;
  }

  /** @inheritdoc */
  setTracker(tracker: unknown): void {
    this.tracker = tracker as ExternalEditTracker;
  }

  /** Set the session ID after construction */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /** Set the workspace directory after construction */
  setDirectory(directory: string): void {
    (this as unknown as { directory?: string }).directory = directory;
  }

  /** Set the known file URIs after construction */
  setKnownFileUris(knownFileUris: Set<string>): void {
    this.knownFileUris = knownFileUris;
  }

  /** @inheritdoc */
  processEvent(event: AcpEvent): void {
    const stream = this.stream;
    if (!stream) return;
    // Probe stream capabilities for replay (same check as run())
    this.hasThinking = typeof (stream as any).thinkingProgress === 'function';
    this.hasToolUI = typeof (stream as any).beginToolInvocation === 'function';
    this.dispatchEvent(event, stream as Stream);
  }

  /** @inheritdoc */
  getUserMessageId(): string | null {
    return this.userMessageId;
  }

  /** @inheritdoc */
  getSessionTitle(): string | null {
    return this.sessionTitle ?? null;
  }

  // -------------------------------------------------------------------
  // Backward compat (tests still use this path)
  // -------------------------------------------------------------------

  /** Whether at least one subagent (task) tool completed during this session.
   *  Set to true after a background task finishes; used by the handler to decide
   *  whether to send a continuation prompt after bridge stop. */
  getHadSubagentTasks(): boolean {
    return this.hadSubagentTasks;
  }

  // -------------------------------------------------------------------
  // run() — live event loop
  // -------------------------------------------------------------------

  /**
   * Primary bridge method: consume ACP events directly from the backend
   * and render them to the stream that was set via {@link setStream}.
   *
   * @param events Async iterable of AcpEvent from the backend
   * @param token Cancellation token
   * @returns true if the stream completed without cancellation
   */
  async run(
    events: AsyncIterable<AcpEvent>,
    token: vscode.CancellationToken,
  ): Promise<boolean> {
    const stream = this.stream as Stream;
    if (!stream) {
      this.log('bridge error: no stream set (call setStream first)');
      return false;
    }
    this.hasThinking = typeof stream.thinkingProgress === 'function';
    this.hasToolUI = typeof stream.beginToolInvocation === 'function';
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
        this.log('[lifecycle] waiting for next event...');
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
          if (done) {
            this.log('[lifecycle] iterator returned done=true, exiting bridge loop');
            break;
          }
          if (!event) {
            this.log('[lifecycle] iterator returned null event, exiting bridge loop');
            break;
          }

          this.log(`[lifecycle] received event type=${event.type}`);

          const tEnter = Date.now();
          // Handle permission.asked as sync barrier (async, blocks loop until baseline captured + auto-reply)
          if (event.type === 'permission.asked') {
            await this.handlePermissionAsked(event, stream);
            this.logTag('timing', `permission.asked took ${Date.now() - tEnter}ms`);
            continue;
          }
          // Handle question.asked as sync barrier (async, blocks loop until user answers)
          if (event.type === 'question.asked') {
            await this.handleQuestionAsked(event, stream);
            this.logTag('timing', `question.asked took ${Date.now() - tEnter}ms`);
            this.log('[lifecycle] question.asked completed, continuing bridge loop to wait for next event');
            continue;
          }
          const dispatched = this.dispatchEvent(event, stream);
          // Persist via callbacks after processing
          if (this.callbacks) {
            this.callbacks.onEvent(event as AcpEvent);
          } else {
            console.log(`[OpenCodeBridge] no callbacks set — event ${event.type} not persisted`);
          }

          const tProcessed = Date.now();
          this.logTag('timing', `processEvent: type=${event.type}, rendered=${dispatched.rendered}, took ${tProcessed - tEnter}ms`);
          if (dispatched.rendered) {
            await yieldToEventLoop();
            this.logTag('timing', `yieldToEventLoop resolved, total=${Date.now() - tEnter}ms`);
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
      }
      this.logTag('lifecycle', 'bridge loop completed');
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
    this.setStream(stream);
    return this.run(events.stream, token);
  }

  // -------------------------------------------------------------------
  // Event dispatch
  // -------------------------------------------------------------------

  private dispatchEvent(event: AcpEvent, stream: Stream): EventDispatchResult {
    this.logTag('event', `dispatchEvent: type=${event.type}`);

    if (!this.shouldProcessEvent(event)) {
      const eventSessionId = getEventSessionId(event);
      this.logTag('event', `skip: type=${event.type}, sessionID=${eventSessionId ?? 'unknown'}, target=${this.sessionId ?? 'any'}`);
      return { stop: false, rendered: false };
    }

    // Handle forwarded child/descendant session events
    const eventSessionId = getEventSessionId(event);
    if (eventSessionId && this.sessionId && eventSessionId !== this.sessionId) {
      // This event is from a child or descendant session (forwarded by event-broker)

      // Find which subagent scope owns this session (direct child or descendant)
      const owningScope = this.findScopeForSession(eventSessionId);

      if (event.type === 'session.idle') {
        // A descendant session went idle.
        // Track it in the scope's descendant set.
        if (owningScope) {
          owningScope.descendantSessionIds.add(eventSessionId);
        }

        // Check if this is the direct child session going idle
        if (owningScope?.childSessionId === eventSessionId && !owningScope.childIdle) {
          // The direct child is idle, but its descendants may still be running.
          // Only mark as truly complete if ALL descendant sessions are idle.
          // For now, record the event and check completion below.
          this.logTag('subagent', `direct child session idle: childSessionId=${eventSessionId}, callID=${owningScope.callId}`);
        } else {
          this.logTag('subagent', `descendant session idle: sessionId=${eventSessionId}, scope=${owningScope?.callId ?? 'none'}`);
        }

        // Check if the owning scope's entire session tree is idle
        if (owningScope) {
          // If the direct child session hasn't gone idle yet, don't complete the scope
          if (owningScope.childSessionId === eventSessionId || owningScope.childIdle) {
            // Direct child is idle (or this IS the direct child going idle) —
            // check if all known descendants are accounted for.
            // A scope is complete when its direct child has gone idle.
            // For nested subagents, the child session will only go idle
            // after ALL its own descendants complete (the event-broker
            // forwards descendant idle events, but the child session.idle
            // itself only fires when the SDK session is truly done).
            if (owningScope.childSessionId === eventSessionId && !owningScope.childIdle) {
              owningScope.childIdle = true;
              owningScope.timeEnd = Date.now();
              // Push final completed subagent card
              this.pushFinalSubagentUpdate(stream, owningScope);
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
                    if (s.childIdle) {this.activeSubagentScopes.delete(callId);}
                  }
                  this.logTag('subagent', 'all child sessions idle — waiting for parent orchestrator to continue');
                  return { stop: false, rendered: false };
                }
              }
            }
          }
        }
      } else if (event.type === 'session.status') {
        // Child/descendant session status update — log but don't stop
        const statusEvent = event as any;
        this.logTag('subagent', `descendant session status: sessionId=${eventSessionId}, status=${statusEvent.status?.type}`);
      } else if (event.type === 'part.updated') {
        if (event.part?.type === 'tool') {
          // Capture child/descendant tool call for subagent progress display.
          const childToolName = (event.part as any).toolName ?? 'unknown';
          const childPartId = (event.part as any).id ?? '';
          const childCallId = (event.part as any).callId ?? childPartId;
          const childState = (event.part as any).state;
          const childStatus = childState?.status ?? 'running';
          const childTitle = childState?.title;

          let matchingScope = owningScope;
          if (!matchingScope) {
            // Lazy bind: first scope without a childSessionId gets this session
            matchingScope = [...this.activeSubagentScopes.values()]
              .find(s => !s.childSessionId);
            if (matchingScope) {
              matchingScope.childSessionId = eventSessionId;
              this.logTag('subagent', `lazy-bound childSessionId=${eventSessionId} to callID=${matchingScope.callId}`);
            }
          }
          if (matchingScope) {
            matchingScope.descendantSessionIds.add(eventSessionId);
            matchingScope.toolCalls.push({
              name: childToolName,
              title: childTitle ?? undefined,
              status: childStatus,
            });
            // Update parent task tool card in real-time so subagent activity
            // appears inside the subagent card in VSCode chat.
            this.updateSubagentCard(stream, matchingScope, childToolName, childTitle, childStatus);
            // Forward child tool invocation to VSCode with subAgentInvocationId
            // so VSCode groups it under the parent subagent card.
            // Uses pushToolInvocation() for full toolSpecificData rendering.
            if (matchingScope.subAgentInvocationId) {
              if (childStatus === 'completed' || childStatus === 'error') {
                if (this.hasToolUI && VS.ChatToolInvocationPart && typeof stream.push === 'function') {
                  try {
                    if (stream.beginToolInvocation) {
                      stream.beginToolInvocation(childCallId, childToolName, {
                        subagentInvocationId: matchingScope.subAgentInvocationId,
                      } as any);
                    }
                    this.pushToolInvocation(
                      stream, childCallId, childToolName, childState as AcpToolState,
                      childStatus === 'error',
                      matchingScope.subAgentInvocationId,
                    );
                  } catch { /* best-effort */ }
                }
              } else {
                if (this.hasToolUI && stream.beginToolInvocation) {
                  try {
                    stream.beginToolInvocation(childCallId, childToolName, {
                      subagentInvocationId: matchingScope.subAgentInvocationId,
                    } as any);
                  } catch { /* best-effort */ }
                }
              }
            }
          } else {
            this.logTag('subagent',
              `descendant tool event with no matching scope: sessionID=${eventSessionId}, ` +
              `tool=${childToolName}, activeScopes=[${[...this.activeSubagentScopes.values()]
                .map(s => s.childSessionId ?? '?').join(', ')}]`,
            );
          }
        } else if (event.part?.type === 'text') {
          // Collect text output from child/descendant sessions
          if (owningScope) {
            const text = (event.part as any).text;
            if (text && text.trim().length > 0) {
              owningScope.lastText = text;
            }
          }
        }
      }
      // Don't render child session events as parent events
      return { stop: false, rendered: false };
    }

    // Pre-register part IDs before subagent filtering so that parent-level
    // parts (e.g. AI response text arriving after subagent completion)
    // are not incorrectly classified as subagent-internal.
    if (event.type === 'part.updated' && event.part) {
      const p = event.part as { type?: string; id?: string };
      if (p.type === 'text' && p.id && !this.partKinds.has(p.id)) {
        // Tentatively register — handlePartUpdated may refine later
        this.partKinds.set(p.id, 'text');
      }
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
            `timeout=${OpenCodeBridge.DEFERRED_IDLE_TIMEOUT_MS / 1000}s`,
          );
          return { stop: false, rendered: false };
        }
        return { stop: true, rendered: false };
      case 'session.updated': {
        // Backend may auto-generate a meaningful title and broadcast it via
        // session.updated. Capture it so the handler can update the session list.
        const lifecycle = event as AcpSessionLifecycleEvent;
        const rawTitle = lifecycle.title;
        const trimmedTitle = rawTitle?.trim();
        this.logTag(
          'title',
          `session.updated: sessionId=${lifecycle.sessionId}, rawTitle=${JSON.stringify(rawTitle)}, trimmed=${JSON.stringify(trimmedTitle)}`,
        );
        if (trimmedTitle) {
          this.sessionTitle = trimmedTitle;
        }
        return { stop: false, rendered: false };
      }
      case 'session.diff':
        return { stop: false, rendered: this.handleSessionDiff(event, stream) };
      case 'session.error': {
        const message = 'error' in event && typeof event.error === 'string'
          ? (event as any).error
          : 'Session error';
        this.log(`session.error: ${message}`);
        stream.markdown(`\n⚠️ ${message}\n`);
        return { stop: false, rendered: true };
      }
      default:
        return { stop: false, rendered: false };
    }
  }

  /** Check if event should be processed by this bridge (filters by target session). */
  private shouldProcessEvent(evt: AcpEvent): boolean {
    if (!this.sessionId) {return true;}

    switch (evt.type) {
      case 'part.updated':
      case 'part.delta': {
        const eventSessionId = getEventSessionId(evt);
        // Allow parent session events and all child session events.
        // Child routing block (dispatchEvent) handles matching/scoping;
        // filtering here would drop child tool events that arrive before
        // task:completed (when childSessionId is not yet on the scope).
        if (!eventSessionId || eventSessionId === this.sessionId) {return true;}
        return true;
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
      const normalizedPath = rawUri.path.replace(/^\/([A-Z]):\//, (_match: string, drive: string) => `/${drive.toLowerCase()}:`);
      const fileUri = rawUri.path !== normalizedPath
        ? rawUri.with({ path: normalizedPath })
        : rawUri;

      // Skip if this callID is already tracked, or if the file already has an active
      // ExternalEditPart (VSCode only supports one per file at a time).
      if (this.tracker.hasEdit(callID)) {
        this.logTag('edit', `trackEdit skipped — callID=${callID} already tracked`);
      } else if (this.tracker.isTrackingAny([fileUri])) {
        this.logTag('edit', `trackEdit skipped — file ${filepath} already has an active edit, callID=${callID}`);
      } else {
        try {
          await this.tracker.trackEdit(callID, [fileUri], stream);
          this.logTag('edit', `tracked edit callID=${callID}, file=${filepath}`);
          // Emit snapshot after tracking
          this.callbacks?.onSnapshot({
            uri: filepath,
            content: '',
            editIndex: this.editCounter++,
            toolCallId: callID,
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          this.logTag('edit', `trackEdit error for callID=${callID}: ${err}`);
        }
      }
    }

    // Auto-reply: once (do-edit) for write/permission events
    if (sessionId && permissionId && this.permissions) {
      try {
        await this.permissions.reply(sessionId, permissionId, 'once', this.directory);
        this.logTag('permission', `auto-replied to permission ${permissionId} (once)`);
      } catch (err) {
        this.logTag('permission', `auto-reply failed for permission ${permissionId}: ${err}`);
      }
    }
    return false;
  }

  // -------------------------------------------------------------------
  // question.asked — sync barrier for user input
  // -------------------------------------------------------------------

  private async handleQuestionAsked(event: AcpQuestionRequestEvent, stream: Stream): Promise<boolean> {
    const questionId = event.questionId;
    const sessionId = event.sessionId;
    const questions = event.questions;

    this.log(
      `question.asked: id=${questionId}, sessionID=${sessionId}, questions=${questions.length}`,
    );

    // Try VSCode proposed API questionCarousel first
    if (typeof stream.questionCarousel === 'function') {
      try {
        // Map OpenCode QuestionInfo → VSCode ChatQuestion
        const vscodeQuestions: ChatQuestion[] = questions.map((q, i) => {
          const hasOptions = q.options && q.options.length > 0;
          const isMultiple = q.multiple ?? false;
          const isCustom = q.custom ?? false;

          const chatQuestion = new ChatQuestion(
            `q_${i}`,
            !hasOptions
              ? ChatQuestionType.Text
              : isMultiple
                ? ChatQuestionType.MultiSelect
                : ChatQuestionType.SingleSelect,
            q.header ?? q.question,
            {
              message: q.question,
              options: q.options?.map((o, j) => ({
                id: `opt_${j}`,
                label: o.label,
                value: o.label,
                detail: o.description,
              })),
            },
          );

          // Allow freeform input if custom=true
          if (isCustom && hasOptions) {
            chatQuestion.placeholder = 'Type your own answer...';
          }

          return chatQuestion;
        });

        this.log(`question.asked: showing questionCarousel with ${vscodeQuestions.length} questions`);
        const result = await stream.questionCarousel(vscodeQuestions, true);
        this.log(`question.asked: questionCarousel resolved, result=${JSON.stringify(result)}`);

        if (result === undefined) {
          // User skipped / cancelled
          if (this.questions && sessionId && questionId) {
            try {
              await this.questions.reject(sessionId, questionId, this.directory);
              this.logTag('question', `rejected question ${questionId} (user skipped)`);
            } catch (err) {
              this.logTag('question', `reject failed for question ${questionId}: ${err}`);
            }
          }
        } else {
          // User answered — map VSCode answers back to OpenCode format
          // VSCode questionCarousel returns Record<string, IChatQuestionAnswerValue>:
          //   - Text: string (direct value)
          //   - SingleSelect: { selectedValue: unknown, freeformValue?: string }
          //   - MultiSelect: { selectedValues: unknown[], freeformValue?: string }
          const answers: Array<Array<string>> = questions.map((q, i) => {
            const key = `q_${i}`;
            const answer = result[key];

            if (answer === undefined || answer === null) {
              return [];
            }

            // Text answer — direct string
            if (typeof answer === 'string') {
              return [answer];
            }

            if (typeof answer === 'object' && answer !== null) {
              const obj = answer as Record<string, unknown>;

              // SingleSelect: { selectedValue: unknown, freeformValue?: string }
              if ('selectedValue' in obj) {
                // Prefer freeformValue if user typed a custom answer
                if (obj.freeformValue && typeof obj.freeformValue === 'string') {
                  return [obj.freeformValue];
                }
                const val = obj.selectedValue;
                if (val !== undefined && val !== null) {
                  return [String(val)];
                }
                return [];
              }

              // MultiSelect: { selectedValues: unknown[], freeformValue?: string }
              if ('selectedValues' in obj && Array.isArray(obj.selectedValues)) {
                const selected = (obj.selectedValues as unknown[]).map(v =>
                  v !== undefined && v !== null ? String(v) : '',
                ).filter(v => v !== '');
                // Also include freeformValue if present
                if (obj.freeformValue && typeof obj.freeformValue === 'string') {
                  selected.push(obj.freeformValue);
                }
                return selected;
              }
            }

            return [];
          });

          if (this.questions && sessionId && questionId) {
            try {
              this.logTag('question', `sending reply to question ${questionId}: sessionId=${sessionId}, answers=${JSON.stringify(answers)}, directory=${this.directory ?? 'none'}`);
              await this.questions.reply(sessionId, questionId, answers, this.directory);
              this.logTag('question', `replied to question ${questionId} successfully, answers=${JSON.stringify(answers)}`);
            } catch (err) {
              this.logTag('question', `reply FAILED for question ${questionId}: ${err}`);
            }
          } else {
            this.logTag('question', `WARNING: cannot reply — questions=${!!this.questions}, sessionId=${sessionId}, questionId=${questionId}`);
          }
        }

        return false; // questionCarousel handles its own UI
      } catch (err) {
        this.logTag('question', `questionCarousel error: ${err}`);
        // Fall through to fallback
      }
    }

    // Fallback: use vscode.window.showQuickPick for single-question scenarios
    if (questions.length > 0) {
      try {
        const q = questions[0];
        if (q.options && q.options.length > 0) {
          const picks = q.options.map(o => ({
            label: o.label,
            description: o.description,
          }));
          const selected = await vscode.window.showQuickPick(picks, {
            placeHolder: q.question,
            canPickMany: q.multiple ?? false,
          });

          if (selected) {
            const answers: Array<Array<string>> = [];
            if (Array.isArray(selected)) {
              answers.push(selected.map(s => s.label));
            } else {
              answers.push([selected.label]);
            }

            if (this.questions && sessionId && questionId) {
              await this.questions.reply(sessionId, questionId, answers, this.directory);
            }
          } else {
            if (this.questions && sessionId && questionId) {
              await this.questions.reject(sessionId, questionId, this.directory);
            }
          }
        } else {
          // Text input question
          const answer = await vscode.window.showInputBox({
            prompt: q.question,
            placeHolder: q.header,
          });

          if (answer !== undefined) {
            const answers: Array<Array<string>> = [[answer]];
            if (this.questions && sessionId && questionId) {
              await this.questions.reply(sessionId, questionId, answers, this.directory);
            }
          } else {
            if (this.questions && sessionId && questionId) {
              await this.questions.reject(sessionId, questionId, this.directory);
            }
          }
        }
      } catch (err) {
        this.logTag('question', `fallback UI error: ${err}`);
        // Last resort: reject the question so the server doesn't hang
        if (this.questions && sessionId && questionId) {
          try {
            await this.questions.reject(sessionId, questionId, this.directory);
          } catch { /* ignore */ }
        }
      }
    }

    return false;
  }

  // -------------------------------------------------------------------
  // part.updated
  // -------------------------------------------------------------------

  private handlePartUpdated(event: AcpPartUpdatedEvent, stream: Stream): boolean {
    const part = event.part;
    if (!part) {return false;}

    switch (part.type) {
      case 'text': {
        const textPart = part;
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
        const reasoningPart = part;
        this.partKinds.set(reasoningPart.id, 'reasoning');
        return false;
      }
      case 'tool': {
        this.assistantPhaseStarted = true;
        const toolPart = part;
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
    if (!event.delta) {return false;}

    const partID = event.partId;
    const delta = event.delta;
    const kind = this.partKinds.get(partID);
    const now = Date.now();
    const gap = this.lastDeltaTime ? now - this.lastDeltaTime : 0;
    this.lastDeltaTime = now;
    this.logTag('delta', `partID=${partID}, kind=${kind ?? 'unknown'}, len=${delta.length}, gap=${gap}ms`);

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
    if (!diffs?.length) {return false;}

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

    if (!entries.length) {return false;}

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
    if (!state) {return false;}

    const toolName = part.toolName ?? 'unknown';
    const callID = part.callId ?? part.id;
    const status = state.status;
    this.logTag('tool', `tool=${toolName}, callID=${callID}, status=${status}`);

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

      // Track subagent scope for "task" / "subagent" tools
      if (toolName === 'task' || toolName === 'subagent') {
        if (!this.activeSubagentScopes.has(callID)) {
          // Generate a subAgentInvocationId for grouping child tools under this card.
          const subAgentInvocationId = `subagent-${callID}-${Date.now()}`;
          this.activeSubagentScopes.set(callID, {
            callId: callID,
            childSessionId: undefined,
            descendantSessionIds: new Set(),
            childIdle: false,
            completed: false,
            timeStart: Date.now(),
            timeEnd: undefined,
            toolCalls: [],
            output: undefined,
            lastText: undefined,
            subAgentInvocationId,
          } as SubagentScope);
          this.logTag('subagent', `scope created: callID=${callID}, subAgentInvocationId=${subAgentInvocationId}`);
        }
      }

      // Build invocation message for the tool card
      const meta2 = this.toolMetas.get(callID);
      const title = getToolTitle(state) ?? meta2?.title ?? toolName;
      const invocationMsg = this.formatInvocationMsg(toolName, state.input ?? {}, title);
      this.logTag('tool', `running: callID=${callID}, toolName=${toolName}, hasToolUI=${this.hasToolUI}`);

      // Full toolSpecificData rendering via pushToolInvocation
      // or legacy updateToolInvocation for backward compatibility.
      if (this.progressivePushed.has(callID)) {
        // Already pushed a progressive part — update only.
        if (stream.updateToolInvocation) {
          try {
            stream.updateToolInvocation(callID, {
              invocationMessage: typeof invocationMsg === 'string'
                ? invocationMsg
                : invocationMsg.value,
            });
          } catch { /* best-effort */ }
        }
      } else {
        this.pushToolInvocation(stream, callID, toolName, state, false, undefined);
        this.progressivePushed.add(callID);
      }
      return true;
    }

    if (status === 'completed' || status === 'error') {
      // --- TOOL COMPLETED / ERROR ---
      const meta = this.toolMetas.get(callID);
      if (meta) {
        meta.output = getToolOutput(state) ?? '';
        meta.timeEnd = getToolTime(state)?.end;
        meta.title = getToolTitle(state) ?? meta.title;
      }

      // For subagent tools: the subagent was just created and starts running.
      // At task:completed, pushToolInvocation creates the subagent card with
      // ChatSubagentToolInvocationData. The card shows task tool duration.
      // At child session.idle, pushFinalSubagentUpdate updates with full duration.
      const subagentScope = this.activeSubagentScopes.get(callID);
      if ((toolName === 'task' || toolName === 'subagent') && subagentScope) {
        // Extract child session ID from tool metadata (OpenCode task tool puts it there)
        // Note: childSessionId may already be set via lazy binding if child events arrived first
        const childSessionId = (state.metadata?.sessionId ??
          (typeof state.output === 'string' ? state.output.match(/task_id:\s*(\S+)/)?.[1] : undefined)) as string | undefined;
        if (childSessionId && !subagentScope.childSessionId) {
          subagentScope.childSessionId = childSessionId;
          this.logTag('subagent', `child session ID captured: callID=${callID}, childSessionId=${childSessionId}`);
        }
        // subAgentInvocationId was already generated at task:running (scope creation)
        // so child tool events arriving before task:completed have it available.

        // Save output for the final card push at child session.idle.
        // NOTE: timeEnd is NOT set here — it will be set to Date.now() when the
        // child session goes idle, giving the true creation→completion duration.
        subagentScope.output = getToolOutput(state) ?? '';
        subagentScope.completed = true;
        this.hadSubagentTasks = true;

        this.logTag('subagent', `scope activated (subagent spawned): callID=${callID}, childSessionId=${childSessionId || subagentScope.childSessionId}, subAgentInvocationId=${subagentScope.subAgentInvocationId}`);
        // DON'T push completed card — the subagent is still running!
        // Just update the running card to show it's active.
        // The final completed card will be pushed at child session.idle.
        if (stream.updateToolInvocation) {
          try {
            const input = state.input ?? {};
            const description = (input.description as string) ?? getToolTitle(state) ?? toolName;
            stream.updateToolInvocation(callID, {
              invocationMessage: `Subagent started: ${description}`,
            });
          } catch { /* best-effort */ }
        }
        return true;
      }

      // Complete tracker edit if this is a tracked tool
      if (this.tracker && typeof this.tracker.completeEdit === 'function') {
        try {
          this.tracker.completeEdit(callID);
        } catch { /* best-effort */ }
      }

      // Non-subagent tool completion: push the final tool invocation part
      this.pushToolInvocation(stream, callID, toolName, state, status === 'error', undefined);
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------
  // External edit handling (file snapshot before write)
  // -------------------------------------------------------------------

  private async handleEditSnapshot(
    data: { callId: string; filepath?: string; sessionId?: string },
  ): Promise<void> {
    // Snapshot was already taken during permission.asked via tracker.trackEdit.
    // This is a no-op now since permission.asked already emits the snapshot.
  }

  // -------------------------------------------------------------------
  // Tool card rendering
  // -------------------------------------------------------------------

  /**
   * Push a full tool invocation part to the stream.
   * Used for both progressive (in-flight) and completed tool states.
   */
  private pushToolInvocation(
    stream: Stream,
    callID: string,
    toolName: string,
    state: AcpToolState,
    isError: boolean,
    subAgentInvocationId?: string,
  ): void {
    if (!VS.ChatToolInvocationPart || !stream.push) {
      // Fallback: no ChatToolInvocationPart support — just update tool state
      this.pushToolInvocationFallback(stream, callID, toolName, state, isError, subAgentInvocationId);
      return;
    }

    try {
      const input = state.input ?? {};
      const output = state.output ?? '';
      const title = state.title ?? '';

      // Create ChatToolInvocationPart
      const part: ChatToolInvocationPart = new VS.ChatToolInvocationPart(toolName, callID, isError ? (state.error ?? 'Error') : undefined);
      part.isComplete = !subAgentInvocationId || state.status === 'completed' || state.status === 'error';
      if (state.status === 'pending' || (state.status === 'running' && !this.progressivePushed.has(callID))) {
        part.isComplete = false;
      }

      // invocationMessage: short one-liner for the collapsed card
      // pastTenseMessage: shown when the tool completes (expanded state)
      if (state.status === 'running' || state.status === 'pending') {
        const msg = this.formatInvocationMsg(toolName, input, title);
        part.invocationMessage = typeof msg === 'string' ? msg : msg.value;
      } else if (state.status === 'completed' || state.status === 'error') {
        const pastMsg = this.formatPastTenseMsg(toolName, title, state.startTime, state.endTime, input);
        part.pastTenseMessage = typeof pastMsg === 'string' ? pastMsg : pastMsg.value;
      }

      // toolSpecificData: rich type-specific rendering
      const specific = this.buildToolSpecificData(toolName, input, output, title);
      if (specific) {
        part.toolSpecificData = specific as ChatToolSpecificData;
      }

      // subAgentInvocationId: group child tools under a subagent card
      if (subAgentInvocationId) {
        part.subAgentInvocationId = subAgentInvocationId;
      }

      stream.push(part as unknown as vscode.ChatResponsePart);
      this.logTag('tool', `pushed ChatToolInvocationPart: callID=${callID}, toolName=${toolName}, isComplete=${part.isComplete}, hasToolSpecific=${!!specific}`);
    } catch {
      this.pushToolInvocationFallback(stream, callID, toolName, state, isError, subAgentInvocationId);
    }
  }

  /**
   * Fallback tool rendering when ChatToolInvocationPart is not available.
   * Uses stream.beginToolInvocation / updateToolInvocation.
   */
  private pushToolInvocationFallback(
    stream: Stream,
    callID: string,
    toolName: string,
    state: AcpToolState,
    isError: boolean,
    subAgentInvocationId?: string,
  ): void {
    if (!this.hasToolUI) {
      return;
    }

    const title = state.title ?? toolName;
    const input = state.input ?? {};

    if (state.status === 'pending') {
      try {
        stream.beginToolInvocation?.(callID, toolName, subAgentInvocationId ? { subAgentInvocationId } as any : undefined);
      } catch { /* ignore */ }
      return;
    }

    if (state.status === 'running') {
      try {
        const msg = this.formatInvocationMsg(toolName, input, title);
        stream.updateToolInvocation?.(callID, {
          invocationMessage: typeof msg === 'string' ? msg : msg.value,
        } as any);
      } catch { /* ignore */ }
      return;
    }

    if (state.status === 'completed' || state.status === 'error') {
      const pastMsg = this.formatPastTenseMsg(toolName, title, state.startTime, state.endTime, input);
      try {
        stream.updateToolInvocation?.(callID, {
          pastTenseMessage: typeof pastMsg === 'string' ? pastMsg : pastMsg.value,
          invocationMessage: isError ? `✗ ${toolName}` : `✓ ${toolName}`,
        } as any);
      } catch { /* ignore */ }
    }
  }

  /**
   * Build tool-specific data for the ChatToolInvocationPart.
   * Returns appropriate data based on the tool name and its input/output.
   */
  private buildToolSpecificData(
    toolName: string,
    input: Record<string, unknown>,
    output: string,
    title: string,
  ): ChatTerminalToolInvocationData | ChatSimpleToolResultData | ChatToolResourcesInvocationData | ChatSubagentToolInvocationData | ChatTodoToolInvocationData | undefined {
    const formatInput = (data: Record<string, unknown>, fallbackTitle: string): string => {
      const keys = Object.keys(data);
      if (keys.length === 0) {return fallbackTitle;}
      const parts = keys.map((k) => {
        const val = typeof data[k] === 'string'
          ? (data[k] as string).substring(0, 100)
          : JSON.stringify(data[k]).substring(0, 100);
        return `${k}: ${val}`;
      });
      return parts.join('\n');
    };

    const truncate = (s: string, max: number): string =>
      s.length > max ? s.substring(0, max) + '...' : s;

    switch (toolName) {
      case 'read':
      case 'write':
      case 'edit': {
        const filePath = (input.filePath as string) ?? (input.path as string) ?? '';
        const offset = input.offset as number | undefined;
        const limit = input.limit as number | undefined;
        if (filePath) {
          return { values: [vscode.Uri.file(filePath)] } satisfies ChatToolResourcesInvocationData;
        }
        return {
          input: formatInput(input, title),
          output: truncate(output, 2000),
        } satisfies ChatSimpleToolResultData;
      }

      case 'bash': {
        const command = (input.command as string) ?? (input.script as string) ?? formatInput(input, title);
        const exitCode = ((): number | undefined => {
          if (stateOutputHasExitCode(output)) {
            const match = output.match(/exitCode:\s*(-?\d+)/);
            return match ? parseInt(match[1], 10) : undefined;
          }
          return undefined;
        })();
        return {
          commandLine: { original: command },
          language: (input.language as string) ?? 'bash',
          output: output ? { text: truncate(output, 2000) } : undefined,
          state: exitCode != null ? { exitCode } : undefined,
        } satisfies ChatTerminalToolInvocationData;
      }

      case 'list':
      case 'grep':
      case 'glob':
      case 'websearch':
      case 'websearch_web_search_exa':
      case 'read_url':
      case 'readUrl':
      case 'fetch':
      case 'context': {
        return {
          input: formatInput(input, title),
          output: truncate(output, 2000),
        } satisfies ChatSimpleToolResultData;
      }

      case 'todo': {
        const todos = input.todos as Array<{ content: string; status: string }> | undefined;
        if (todos) {
          // Subagent: use simple result format
          const check = (s: string) =>
            s === 'completed' ? '✓' : s === 'in_progress' ? '⟳' : '○';
          const formatted = todos.map((item, idx) => {
            return `[${check(item.status)}] ${idx + 1}. ${item.content}`;
          }).join('\n');
          return {
            input: formatted,
            output: truncate(output, 2000),
          } satisfies ChatSimpleToolResultData;
        }
        // Root session: use proper ChatTodoToolInvocationData
        const todoList = (todos ?? []).map((item: { content: string; status: string }, idx: number) => ({
          id: idx,
          title: item.content,
          status: item.status === 'completed'
            ? ChatTodoStatus.Completed
            : item.status === 'in_progress'
              ? ChatTodoStatus.InProgress
              : ChatTodoStatus.NotStarted,
        }));
        return { todoList } satisfies ChatTodoToolInvocationData;
      }

      case 'task':
      case 'subagent': {
        const description = (input.description as string) ?? title;
        const agentName = (input.agentName as string) ?? (input.agent_type as string) ?? title ?? toolName;
        const prompt = (input.prompt as string) ?? formatInput(input, '');
        const result = truncate(output, 4000);
        // Use ChatSubagentToolInvocationData constructor if available at runtime
        if (VS.ChatSubagentToolInvocationData) {
          return new VS.ChatSubagentToolInvocationData(
            description,
            agentName,
            prompt,
            result,
          ) satisfies ChatSubagentToolInvocationData;
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
  ): string | vscode.MarkdownString {
    const formatFileBubbleMessage = (
      verb: 'Read' | 'Editing' | 'Writing',
      filePath: string,
      offset?: number,
      limit?: number,
    ): vscode.MarkdownString => {
      const uri = vscode.Uri.file(filePath).toString().toLowerCase();
      const range = offset != null || limit != null
        ? (() => {
            const start = offset ?? 1;
            const end = limit != null ? start + limit - 1 : start;
            return `#${start}-${end}`;
          })()
        : '';
      return new vscode.MarkdownString(`${verb} [](${uri}${range})`);
    };

    if (toolName === 'read') {
      const filePath = input?.filePath as string | undefined;
      if (filePath) {
        const offset = input?.offset as number | undefined;
        const limit = input?.limit as number | undefined;
        return formatFileBubbleMessage('Read', filePath, offset, limit);
      }
    } else if (toolName === 'edit') {
      const filePath = input?.filePath as string | undefined;
      if (filePath) {
        return formatFileBubbleMessage('Editing', filePath);
      }
    } else if (toolName === 'write') {
      const filePath = input?.filePath as string | undefined;
      if (filePath) {
        return formatFileBubbleMessage('Writing', filePath);
      }
    } else if (toolName === 'bash') {
      const command = (input.command as string) ?? (input.script as string) ?? title;
      const short = command.length > 80 ? command.substring(0, 77) + '...' : command;
      return `\`${short}\``;
    } else if (toolName === 'todo') {
      return `Todos`;
    } else if (toolName === 'task' || toolName === 'subagent') {
      const desc = (input.description as string) ?? title;
      return `Subagent: ${desc}`;
    } else if (toolName === 'list' || toolName === 'grep') {
      const filePath = (input.filePath as string) ?? (input.path as string) ?? (input.pattern as string) ?? title;
      const short = filePath.length > 60 ? filePath.substring(0, 57) + '...' : filePath;
      return `${toolName === 'list' ? 'List' : 'Search'} \`${short}\``;
    } else if (toolName === 'glob') {
      const pattern = (input.pattern as string) ?? title;
      const short = pattern.length > 60 ? pattern.substring(0, 57) + '...' : pattern;
      return `Glob \`${short}\``;
    } else if (toolName === 'websearch' || toolName === 'websearch_web_search_exa') {
      const query = (input.query as string) ?? title;
      if (query) {
        const short = query.length > 80 ? query.substring(0, 77) + '...' : query;
        return new vscode.MarkdownString(`Web Searching \`${short}\``);
      }
    }

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
    input?: Record<string, unknown>,
  ): string | vscode.MarkdownString {
    const duration = (timeStart != null && timeEnd != null)
      ? ` (${((timeEnd - timeStart) / 1000).toFixed(1)}s)`
      : '';

    const formatFileBubbleMessage = (
      verb: 'Read' | 'Edited' | 'Wrote',
      filePath: string,
      offset?: number,
      limit?: number,
      suffix = '',
    ): vscode.MarkdownString => {
      const uri = vscode.Uri.file(filePath).toString().toLowerCase();
      const range = offset != null || limit != null
        ? (() => {
            const start = offset ?? 1;
            const end = limit != null ? start + limit - 1 : start;
            return `#${start}-${end}`;
          })()
        : '';
      let lineInfo = '';
      if (offset != null || limit != null) {
        const start = offset ?? 1;
        const end = limit != null ? start + limit - 1 : undefined;
        lineInfo = end != null ? ` line ${start}-${end}` : ` line ${start}`;
      }
      return new vscode.MarkdownString(`${verb} [](${uri}${range})${lineInfo}${suffix}${duration}`);
    };

    // --- read: keep official-style file bubble in completed state ---
    // IMPORTANT: completed-state `pastTenseMessage` is the critical preservation point.
    // If this returns plain text, the bubble may render briefly during the running state
    // and then disappear as soon as the tool completes.
    if (toolName === 'read') {
      const filePath = input?.filePath as string | undefined;
      if (filePath) {
        const offset = input?.offset as number | undefined;
        const limit = input?.limit as number | undefined;
        return formatFileBubbleMessage('Read', filePath, offset, limit);
      }
    } else if (toolName === 'edit') {
      const filePath = input?.filePath as string | undefined;
      if (filePath) {
        const offset = input?.offset as number | undefined;
        const limit = input?.limit as number | undefined;
        return formatFileBubbleMessage('Edited', filePath, offset, limit, '');
      }
    } else if (toolName === 'write') {
      const filePath = input?.filePath as string | undefined;
      if (filePath) {
        return formatFileBubbleMessage('Wrote', filePath, undefined, undefined, '');
      }
    } else if (toolName === 'bash') {
      const command = (input?.command as string) ?? (input?.script as string) ?? title;
      const short = command.length > 60 ? command.substring(0, 57) + '...' : command;
      return `\`${short}\`${duration}`;
    } else if (toolName === 'list') {
      const filePath = (input?.filePath as string) ?? (input?.path as string) ?? title;
      const short = filePath.length > 60 ? filePath.substring(0, 57) + '...' : filePath;
      return `Listed \`${short}\`${duration}`;
    } else if (toolName === 'grep') {
      const pattern = (input?.pattern as string) ?? title;
      const short = pattern.length > 60 ? pattern.substring(0, 57) + '...' : pattern;
      return `Searched \`${short}\`${duration}`;
    } else if (toolName === 'glob') {
      const pattern = (input?.pattern as string) ?? title;
      const short = pattern.length > 60 ? pattern.substring(0, 57) + '...' : pattern;
      return `Globbed \`${short}\`${duration}`;
    } else if (toolName === 'todo') {
      return `Updated todos${duration}`;
    } else if (toolName === 'websearch' || toolName === 'websearch_web_search_exa') {
      const query = (input?.query as string) ?? title;
      if (query) {
        const short = query.length > 80 ? query.substring(0, 77) + '...' : query;
        return `Web Searched \`${short}\`${duration}`;
      }
    } else if (toolName === 'task' || toolName === 'subagent') {
      const desc = (input?.description as string) ?? title;
      return `Subagent: ${desc}${duration}`;
    }

    const display = title || toolName;
    return `Completed ${display}${duration}`;
  }

  // -------------------------------------------------------------------
  // Subagent card rendering
  // -------------------------------------------------------------------

  /** Push a completed subagent card with its tool call summary. */
  private pushFinalSubagentUpdate(stream: Stream, scope: SubagentScope): void {
    if (!VS.ChatToolInvocationPart || !stream.push) {
      // Fallback: update invocation message only
      if (stream.updateToolInvocation) {
        try {
          const progress = scope.toolCalls.length > 0
            ? formatSubagentProgress(scope)
            : undefined;
          stream.updateToolInvocation(scope.callId, {
            invocationMessage: progress ? `Completed: ${progress}` : 'Subagent finished',
          });
        } catch { /* ignore */ }
      }
      return;
    }

    let progress: string | undefined;
    try {
      progress = scope.toolCalls.length > 0
        ? formatSubagentProgress(scope)
        : undefined;
      const description = scope.lastText
        ? scope.lastText.substring(0, 200)
        : (progress ?? 'Subagent task');
      const agentName = 'subagent';
      const prompt = scope.lastText ?? '';
      const result = scope.output ?? scope.lastText ?? '';

      const part: ChatToolInvocationPart = new VS.ChatToolInvocationPart('subagent', scope.callId);
      part.isComplete = true;
      part.subAgentInvocationId = scope.subAgentInvocationId;
      part.invocationMessage = progress
        ? `Subagent: ${progress}`
        : 'Subagent task';

      const timeStart = (scope as any).timeStart as number | undefined;
      const duration = timeStart != null && scope.timeEnd != null
        ? ` (${((scope.timeEnd - timeStart) / 1000).toFixed(1)}s)`
        : '';
      part.pastTenseMessage = `Subagent completed${duration}`;

      if (VS.ChatSubagentToolInvocationData) {
        part.toolSpecificData = new VS.ChatSubagentToolInvocationData(
          description,
          agentName,
          prompt,
          truncate(result, 4000),
        );
      } else {
        part.toolSpecificData = {
          description,
          agentName,
          prompt,
          result: truncate(result, 4000),
        } satisfies ChatSubagentToolInvocationData;
      }

      stream.push(part as unknown as vscode.ChatResponsePart);
      this.logTag('subagent',
        `final subagent card pushed: callID=${scope.callId}, toolCalls=${scope.toolCalls.length}, progress="${progress}"`,
      );
    } catch {
      // Best-effort fallback: update invocationMessage only
      if (stream.updateToolInvocation) {
        try {
          stream.updateToolInvocation(scope.callId, {
            invocationMessage: progress ? `Completed: ${progress}` : `Subagent finished`,
          });
        } catch { /* ignore */ }
      }
    }
  }

  /**
   * Capture a subagent-internal event for progress aggregation.
   * Tool events are tracked (for the summary like "3 reads, 2 edits").
   * Text events are collected (lastText) for the subagent summary.
   * Also pushes real-time invocation message updates to the parent task tool card.
   */
  private captureSubagentEvent(event: AcpEvent, stream?: Stream): void {
    // Handle text delta events from subagent — stream text into the subagent card
    if (event.type === 'part.delta') {
      const deltaEvent = event;
      const delta = deltaEvent.delta;
      if (delta) {
        for (const scope of this.activeSubagentScopes.values()) {
          const currentText = (scope.lastText ?? '') + delta;
          scope.lastText = currentText;
          if (stream && this.hasToolUI && stream.updateToolInvocation) {
            try {
              stream.updateToolInvocation(scope.callId, {
                invocationMessage: truncate(currentText, 200),
              });
            } catch { /* best-effort */ }
          }
        }
      }
      return;
    }

    if (event.type !== 'part.updated' || !event.part) {return;}

    // Collect text output from subagent and push to subagent card
    if (event.part.type === 'text') {
      const text = (event.part as any).text;
      if (text && text.trim().length > 0) {
        for (const scope of this.activeSubagentScopes.values()) {
          scope.lastText = text;
          if (stream && this.hasToolUI && stream.updateToolInvocation) {
            try {
              stream.updateToolInvocation(scope.callId, {
                invocationMessage: truncate(text, 200),
              });
            } catch { /* best-effort */ }
          }
        }
      }
      return;
    }

    if (event.part.type !== 'tool') {return;}

    const toolPart = event.part;
    const state = toolPart.state;
    if (!state) {return;}

    const toolName = toolPart.toolName ?? 'unknown';
    const title = state.title;
    const callId = toolPart.callId ?? toolPart.id;
    const status = state.status;

    // Record into all active scopes (typically just one)
    for (const scope of this.activeSubagentScopes.values()) {
      const isNew = !scope.toolCalls.some(t => t.name === toolName);
      scope.toolCalls.push({
        name: toolName,
        title: title ?? undefined,
        status,
      });
      // Update parent task tool card so subagent activity is visible in chat
      if (stream) {
        this.updateSubagentCard(stream, scope, toolName, title, status);
      }
      // Forward to VSCode with subAgentInvocationId so VSCode groups child tools
      // under the parent subagent card (scope mechanism).
      // Forward ALL first-seen child tools (not just 'pending') because child events
      // often arrive already completed by the time the parent processes them.
      if (isNew && scope.subAgentInvocationId && stream) {
        // Tell VSCode this tool belongs to the subagent
        if (this.hasToolUI && stream.beginToolInvocation) {
          try {
            stream.beginToolInvocation(callId, toolName, {
              subagentInvocationId: scope.subAgentInvocationId,
            } as any);
          } catch { /* best-effort */ }
        }
        // If the tool is already done, push its completion state
        if (status === 'completed' || status === 'error') {
          if (this.hasToolUI && stream.push && VS.ChatToolInvocationPart) {
            try {
              const part: ChatToolInvocationPart = new VS.ChatToolInvocationPart(toolName, callId);
              part.subAgentInvocationId = scope.subAgentInvocationId;
              part.isComplete = true;
              part.isError = status === 'error';
              part.invocationMessage = status === 'error' ? `✗ ${toolName}` : `✓ ${toolName}: ${title ?? ''}`;
              stream.push(part as unknown as vscode.ChatResponsePart);
            } catch { /* best-effort */ }
          }
        }
      }
    }

    this.logTag('subagent',
      `capture: tool=${toolName}, status=${state.status}, ` +
      `activeScopes=${this.activeSubagentScopes.size}`,
    );
  }

  /** Update the nested invocation message inside a subagent card in real time. */
  private updateSubagentCard(
    stream: Stream,
    scope: SubagentScope,
    toolName: string,
    title: string | null | undefined,
    status: string,
  ): void {
    if (!this.hasToolUI) {return;}
    try {
      const progress = formatSubagentProgress(scope);
      if (progress && stream.updateToolInvocation) {
        stream.updateToolInvocation(scope.callId, {
          invocationMessage: progress,
        });
      }
    } catch { /* best-effort */ }
  }

  // -------------------------------------------------------------------
  // Child session polling (deferred idle)
  // -------------------------------------------------------------------

  /**
   * Check whether any child sessions are still running (busy).
   * Uses the sessions.status() + sessions.children() APIs to detect busy children.
   */
  private async checkChildSessionsRunning(): Promise<boolean> {
    if (!this.sessions || !this.sessionId) return false;
    try {
      const statusResult = await this.sessions.status(this.directory);
      if (statusResult.error || !statusResult.data) return false;
      return await this.hasBusyDescendant(this.sessionId, new Set(), statusResult.data);
    } catch {
      return false;
    }
  }

  /**
   * Recursively check if any descendant session (child, grandchild, etc.)
   * of `parentId` is still busy.
   */
  private async hasBusyDescendant(
    parentId: string,
    visited: Set<string>,
    statuses: Record<string, AcpSessionStatus>,
  ): Promise<boolean> {
    if (visited.has(parentId)) return false;
    visited.add(parentId);

    const childrenResult = await this.sessions!.children(parentId, this.directory);
    if (childrenResult.error || !childrenResult.data) return false;

    for (const child of childrenResult.data) {
      if (visited.has(child.id)) continue;
      const status = statuses[child.id];
      if (status?.type === 'busy') return true;
      if (await this.hasBusyDescendant(child.id, visited, statuses)) return true;
    }
    return false;
  }

  /**
   * Called when session.idle fires but subagent scopes are all completed.
   * Polls child sessions to see if background tasks are still running.
   * If yes, defers the idle signal; if no, stops the bridge.
   */
  private checkChildSessionsAndMaybeStop(): void {
    if (!this.sessions || !this.sessionId) {
      // No session operations available — push final subagent cards and stop
      this.clearDeferredIdleTimer();
      if (this.stream) {
        for (const scope of this.activeSubagentScopes.values()) {
          if (scope.completed) {
            scope.timeEnd = Date.now();
            this.pushFinalSubagentUpdate(this.stream, scope);
          }
        }
      }
      this.logTag('subagent', 'bridge stop: all subagents completed (no session operations)');
      this.requestStop();
      return;
    }

    this.deferredIdle = true;
    this.startDeferredIdleTimer();
    this.logTag('subagent', 'session.idle deferred: checking child sessions in 2s');

    // Poll child sessions after a short delay
    const pollTimer = setTimeout(async () => {
      try {
        const childrenRunning = await this.checkChildSessionsRunning();
        if (!childrenRunning) {
          this.deferredIdle = false;
          this.clearDeferredIdleTimer();
          this.logTag('subagent', 'all child sessions idle (via poll) — waiting for parent orchestrator to continue');
        } else {
          this.logTag('subagent', 'child sessions still running, polling again in 3s');
          // Schedule another poll — replace the safety timer
          this.checkChildSessionsAndMaybeStop();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logTag('subagent', `child session poll error: ${msg}, stopping bridge`);
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

  // -------------------------------------------------------------------
  // Subagent scope helpers
  // -------------------------------------------------------------------

  /**
   * Find which subagent scope owns a given session ID by walking
   * the session hierarchy.
   */
  private findScopeForSession(sessionId: string): SubagentScope | undefined {
    // 1. Direct match: this session is a known childSessionId
    for (const scope of this.activeSubagentScopes.values()) {
      if (scope.childSessionId === sessionId) {return scope;}
    }

    // 2. Descendant match: walk up parent chain to find which scope owns this session
    if (this.sessions) {
      const childSessionIds = new Set<string>();
      for (const scope of this.activeSubagentScopes.values()) {
        if (scope.childSessionId) {childSessionIds.add(scope.childSessionId);}
      }
      if (childSessionIds.size > 0) {
        const ancestorId = this.sessions.findAncestor(sessionId, childSessionIds);
        if (ancestorId) {
          for (const scope of this.activeSubagentScopes.values()) {
            if (scope.childSessionId === ancestorId) {return scope;}
          }
        }
      }
    }

    return undefined;
  }

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
    if (this.activeSubagentScopes.size === 0) {return false;}

    if (event.type === 'part.updated') {
      const part = event.part;
      if (!part) {return false;}
      // Structural parent parts are never subagent-internal
      if (part.type === 'reasoning' ||
          part.type === 'step-start' || part.type === 'step-finish') {
        return false;
      }
      // Text: subagent-internal if not already tracked as a parent part.
      // This prevents subagent LLM text from being rendered inline;
      // instead it's collected as scope.lastText for the completion summary.
      if (part.type === 'text') {
        return !this.partKinds.has(part.id);
      }
      // Parent-level task/subagent tool invocations are NOT subagent-internal.
      // Without this, a second parallel task tool would be captured instead of rendered.
      if (part.type === 'tool') {
        const toolName = (part).toolName;
        if (toolName === 'task' || toolName === 'subagent') {
          return false;
        }
        // Non-task tools: subagent-internal if partId is unknown.
        return !this.partKinds.has(part.id);
      }
      return false;
    }

    if (event.type === 'part.delta') {
      // Delta events for unknown part IDs are subagent-internal.
      // But deltas for known parent parts must pass through.
      if (event.partId && this.partKinds.has(event.partId)) {
        return false;
      }
      // Without a known parent part, deltas are likely subagent-internal.
      return this.activeSubagentScopes.size > 0;
    }

    return false;
  }

  // -------------------------------------------------------------------
  // Reset
  // -------------------------------------------------------------------

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
        `deferred idle timeout fired (${OpenCodeBridge.DEFERRED_IDLE_TIMEOUT_MS / 1000}s) — ` +
        `closing ${this.activeSubagentScopes.size} remaining subagent scope(s)`,
      );
      this.activeSubagentScopes.clear();
      this.deferredIdleTimer = null;
      // Break the while-loop in run() by resolving the force-stop promise
      this.forceStopResolve?.();
    }, OpenCodeBridge.DEFERRED_IDLE_TIMEOUT_MS);
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

const TRUNCATED_SUFFIX = '... (truncated)';

function truncate(value: string, maxLength: number): string {
  if (!value) {return value;}
  return value.length <= maxLength ? value : value.substring(0, maxLength).replace(/\s+\S*$/, '') + TRUNCATED_SUFFIX;
}

function stateOutputHasExitCode(output: string): boolean {
  return /exitCode:\s*-?\d+/.test(output);
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
