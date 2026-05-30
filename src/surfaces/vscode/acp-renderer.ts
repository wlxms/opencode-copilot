/**
 * ACP (Agent Communication Protocol) event renderer.
 *
 * Converts OpenCode ACP semantic events into VS Code chat output via
 * either stable or proposed API surfaces. Separated from wire-protocol
 * concerns (session filtering, permission auto-reply, etc.) so callers
 * can reuse rendering in any VS Code surface.
 *
 * = Design =
 * - Stateless with respect to wire protocol — all state is rendering-only
 *   (part-kind tracking, tool metadata accumulation).
 * - Uses the `capabilities.ts` helpers to gate proposed APIs at runtime.
 * - Falls back to stable `markdown()` / `progress()` when proposed APIs
 *   are absent.
 * - Does NOT import from `@opencode-ai/sdk` — only uses event types
 *   defined in `../../types/events.ts`.
 */
import * as vscode from 'vscode';

import type {
  AcpEvent,
  AcpStreamPart,
  AcpTextPart,
  AcpReasoningPart,
  AcpToolPart,
  AcpToolState,
  AcpStepPart,
  AcpPartUpdatedEvent,
  AcpPartDeltaEvent,
  AcpSessionDiffEvent,
  AcpSessionIdleEvent,
  AcpFileDiff,
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
  ChatResponseDiffEntry,
  ChatResponseMultiDiffPart,
} from '../../types/vscode-proposed-additions';
import { ChatTodoStatus } from '../../types/vscode-proposed-additions';

import {
  hasThinkingProgress,
  hasToolUI,
  hasChatToolInvocationPart,
  hasChatResponseMultiDiffPart,
  hasChatSubagentToolInvocationData,
} from './capabilities';
import { type SubagentScope, formatSubagentProgress } from '../../participant/subagent';

// ---------------------------------------------------------------------------
// Extended stream type for proposed API methods
// ---------------------------------------------------------------------------

type Stream = vscode.ChatResponseStream & {
  thinkingProgress?(delta: {
    text?: string | string[];
    id?: string;
    metadata?: { readonly [key: string]: unknown };
  }): void;
  beginToolInvocation?(callId: string, name: string, data?: ChatToolInvocationStreamData): void;
  updateToolInvocation?(callId: string, data: ChatToolInvocationStreamData): void;
};

// ---------------------------------------------------------------------------
// Internal runtime access
// ---------------------------------------------------------------------------

const Proposed = vscode as typeof vscode & {
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
  ChatResponseMultiDiffPart?: new (
    value: ChatResponseDiffEntry[],
    title: string,
    readOnly?: boolean,
  ) => ChatResponseMultiDiffPart;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PartKind = 'reasoning' | 'text' | 'tool';

interface ToolMeta {
  name: string;
  input: Record<string, unknown> | undefined;
  output: string | undefined;
  title: string | undefined;
  timeStart: number | undefined;
  timeEnd: number | undefined;
}

export interface RenderResult {
  /** Whether the event was rendered (i.e., produced visible output) */
  rendered: boolean;
  /** Event type that was processed */
  eventType: string;
}

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

export interface RenderLogger {
  appendLine(message: string): void;
}

// ---------------------------------------------------------------------------
// AcpRenderer
// ---------------------------------------------------------------------------

/**
 * Pure ACP event renderer. Converts `OpenCodeEvent` objects to VS Code
 * chat stream output. Does NOT manage wire protocol, session filtering,
 * or permission handling — those are the caller's responsibility.
 *
 * @example
 * ```ts
 * const renderer = new AcpRenderer({ logger: outputChannel });
 * for await (const event of eventStream) {
 *   if (token.isCancellationRequested) break;
 *   renderer.renderEvent(event, stream);
 * }
 * ```
 */
export class AcpRenderer {
  // Rendering state
  private userMessageId: string | null = null;
  private partKinds: Map<string, PartKind> = new Map();
  private toolCallIds: Map<string, string> = new Map();
  private toolMetas: Map<string, ToolMeta> = new Map();
  private assistantPhaseStarted = false;
  private progressivePushed: Set<string> = new Set();
  /** Active subagent scopes — filters child events from rendering as independent cards */
  private activeSubagentScopes: Map<string, SubagentScope> = new Map();

  // Capabilities (cached per render cycle)
  private _hasThinking = false;
  private _hasToolUI = false;

  private readonly logger?: RenderLogger;

  constructor(options?: { logger?: RenderLogger }) {
    this.logger = options?.logger;
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  /**
   * Detect what capabilities the stream supports and cache them.
   * Called automatically by `renderEvent` on first use.
   */
  probeStream(stream: vscode.ChatResponseStream): void {
    this._hasThinking = hasThinkingProgress(stream);
    this._hasToolUI = hasToolUI(stream);
    this.log(
      `probe: hasThinking=${this._hasThinking}, hasToolUI=${this._hasToolUI}`,
    );
  }

  /**
   * Render a single ACP event to the given stream.
   *
   * @returns `RenderResult` indicating whether anything was rendered.
   */
  renderEvent(evt: AcpEvent, stream: vscode.ChatResponseStream): RenderResult {
    const s = stream as Stream;

    // Filter subagent-internal events: suppress rendering, capture for progress summary
    if (this.isSubagentInternalEvent(evt)) {
      this.captureSubagentEvent(evt, s);
      return { rendered: false, eventType: evt.type };
    }

    switch (evt.type) {
      case 'part.updated':
        return {
          rendered: this.handlePartUpdated(evt, s),
          eventType: 'part.updated',
        };
      case 'part.delta':
        return {
          rendered: this.handlePartDelta(evt, s),
          eventType: 'part.delta',
        };
      case 'session.idle': {
        // Check if this is a child session becoming idle.
        // Child session.idle events are forwarded by the event-broker to the
        // parent channel (via childToParent mapping). We match by childSessionId
        // and push the FINAL completed subagent card with aggregated progress.
        const idleSessionId = evt.sessionId;
        if (idleSessionId) {
          for (const scope of this.activeSubagentScopes.values()) {
            if (scope.childSessionId === idleSessionId) {
              scope.childIdle = true;
              // Record the true end time — this is when the subagent truly finished
              scope.timeEnd = Date.now();
              this.log(`child session idle: childSessionId=${idleSessionId}, callID=${scope.callId}, toolCalls=${scope.toolCalls.length}`);
              this.pushFinalSubagentCard(s, scope);
              break;
            }
          }
        }
        return { rendered: false, eventType: 'session.idle' };
      }
      case 'session.diff':
        return {
          rendered: this.handleSessionDiff(evt, s),
          eventType: 'session.diff',
        };
      case 'permission.asked':
        // Permission events are wire-protocol concerns — no rendering needed
        return { rendered: false, eventType: 'permission.asked' };
      case 'question.asked':
      case 'question.replied':
      case 'question.rejected':
        // Question events are handled by StreamBridge — no rendering needed here
        return { rendered: false, eventType: evt.type };
      default:
        return { rendered: false, eventType: evt.type };
    }
  }

  /**
   * Return the captured user message ID, if any.
   * This is the OpenCode message ID of the user's prompt.
   */
   getUserMessageId(): string | null {
    return this.userMessageId;
  }

  /**
   * Clear all rendering state. Call between turns or when starting a new session.
   */
  reset(): void {
    this.userMessageId = null;
    this.partKinds.clear();
    this.toolCallIds.clear();
    this.toolMetas.clear();
    this.progressivePushed.clear();
    this.activeSubagentScopes.clear();
    this.assistantPhaseStarted = false;
    // Keep capability cache — it's per-stream, not per-turn
  }

  // -------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------

  /**
   * Handle a `message.part.updated` event — register part kinds and
   * dispatch tool state transitions.
   */
  private handlePartUpdated(evt: AcpPartUpdatedEvent, stream: Stream): boolean {
    const part = evt.part;
    if (!part) {return false;}

    switch (part.type) {
      case 'text': {
        const textPart = part;
        const msgId = textPart.messageId;
        // Capture user message ID on first text part
        if (
          !this.assistantPhaseStarted &&
          !this.userMessageId &&
          textPart.text.length > 0
        ) {
          this.userMessageId = msgId ?? null;
          this.log(`captured userMessageId=${msgId}`);
          return false;
        }
        // Register assistant text parts
        if (msgId !== this.userMessageId || !this.userMessageId) {
          this.partKinds.set(textPart.id, 'text');
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

      default:
        return false;
    }
  }

  /**
   * Handle a `message.part.delta` event — stream reasoning or text tokens.
   */
  private handlePartDelta(
    evt: AcpPartDeltaEvent,
    stream: Stream,
  ): boolean {
    const partID = evt.partId;
    const delta = evt.delta;
    if (!delta) {return false;}
    const kind = this.partKinds.get(partID);

    if (kind === 'reasoning') {
      if (this._hasThinking && stream.thinkingProgress) {
        stream.thinkingProgress({ text: delta, id: partID });
        return true;
      }
    } else if (kind === 'text') {
      stream.markdown(delta);
      return true;
    }

    return false;
  }

  /**
   * Handle a `session.diff` event — render file diffs using
   * `ChatResponseMultiDiffPart` if available.
   */
  private handleSessionDiff(evt: AcpSessionDiffEvent, stream: Stream): boolean {
    const diffs = evt.diffs;
    if (!diffs?.length) {return false;}

    if (!hasChatResponseMultiDiffPart() || !stream.push) {
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

    const Ctor = Proposed.ChatResponseMultiDiffPart;
    if (!Ctor) {return false;}

    try {
      const diffPart = new Ctor(entries, 'File Changes', true);
      stream.push(diffPart as unknown as vscode.ChatResponsePart);
      this.log(`pushed MultiDiffPart: ${entries.length} file(s) changed`);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------
  // Tool state machine: pending → running → completed / error
  // -------------------------------------------------------------------

  /**
   * Handle a tool state transition event.
   */
  private handleToolState(part: AcpToolPart, stream: Stream): boolean {
    const state = part.state;
    if (!state) {return false;}

    const toolName = part.toolName ?? 'unknown';
    const callID = part.callId ?? part.id;
    const status = state.status;

    if (status === 'pending') {
      return this.handleToolPending(callID, part.id, toolName, stream);
    }

    if (status === 'running') {
      return this.handleToolRunning(callID, toolName, state, stream);
    }

    if (status === 'completed') {
      return this.handleToolCompleted(callID, part.id, toolName, state, stream);
    }

    if (status === 'error') {
      return this.handleToolError(callID, part.id, toolName, state, stream);
    }

    return false;
  }

  private handleToolPending(
    callID: string,
    partId: string,
    toolName: string,
    stream: Stream,
  ): boolean {
    this.toolCallIds.set(partId, callID);
    this.toolMetas.set(callID, {
      name: toolName,
      input: undefined,
      output: undefined,
      title: undefined,
      timeStart: undefined,
      timeEnd: undefined,
    });

    if (this._hasToolUI && stream.beginToolInvocation) {
      stream.beginToolInvocation(callID, toolName);
    } else {
      stream.progress(`\u{1F527} ${toolName}...`);
    }
    return true;
  }

  private handleToolRunning(
    callID: string,
    toolName: string,
    state: AcpToolState,
    stream: Stream,
  ): boolean {
    const meta = this.toolMetas.get(callID);
    if (meta) {
      meta.input = state.input ?? {};
      meta.title = getToolTitle(state);
      meta.timeStart = state.startTime;
    }
    // Track subagent scope so child events get filtered instead of leaking
    // Generate subAgentInvocationId at scope creation so child tools that
    // arrive before task:completed already have the grouping ID.
    if (toolName === 'task' || toolName === 'subagent') {
      this.activeSubagentScopes.set(callID, {
        callId: callID,
        toolCalls: [],
        completed: false,
        // VSCode groups child tools under the parent subagent card by matching
        // child.subAgentInvocationId === parent.toolCallId. Therefore the scope's
        // subAgentInvocationId must be the parent task's own callID.
        subAgentInvocationId: callID,
        toolMeta: {
          toolName,
          title: getToolTitle(state) ?? toolName,
          input: state.input ?? {},
          timeStart: state.startTime,
        },
        descendantSessionIds: new Set(),
      });
      this.log(`subagent scope opened: callID=${callID}, subAgentInvocationId=${callID}`);
    }

    if (!this._hasToolUI || !stream.updateToolInvocation) {
      return false;
    }

    stream.updateToolInvocation(callID, {
      partialInput: state.input ?? {},
    });

    // Progressive push: show a "tool running" spinner in the UI.
    // For subagent tools, attach ChatSubagentToolInvocationData so VSCode
    // renders it as an expandable subagent card from the start.
    if (
      hasChatToolInvocationPart() &&
      stream.push &&
      !this.progressivePushed.has(callID)
    ) {
      const Ctor = Proposed.ChatToolInvocationPart;
      if (Ctor) {
        try {
          const part = new Ctor(toolName, callID);
          part.isComplete = false;
          part.isError = false;
          part.enablePartialUpdate = true;
          const input = state.input ?? {};
          const title = getToolTitle(state) ?? toolName;
          part.invocationMessage = title;
          // For subagent tools, show as expandable subagent card (matches demo pattern)
          if ((toolName === 'task' || toolName === 'subagent') && hasChatSubagentToolInvocationData() && Proposed.ChatSubagentToolInvocationData) {
            const description = (input.description as string) ?? title;
            const agentName = (input.agentName as string) ?? (input.agent_type as string) ?? toolName;
            const prompt = (input.prompt as string) ?? '';
            part.toolSpecificData = new Proposed.ChatSubagentToolInvocationData(
              description,
              agentName,
              prompt,
            );
          }
          stream.push(part as unknown as vscode.ChatResponsePart);
          this.progressivePushed.add(callID);
        } catch {
          // Best-effort; updateToolInvocation is sufficient
        }
      }
    }

    return true;
  }

  private handleToolCompleted(
    callID: string,
    partId: string,
    toolName: string,
    state: AcpToolState,
    stream: Stream,
  ): boolean {
    const meta = this.toolMetas.get(callID);
    if (meta) {
      meta.output = getToolOutput(state) ?? '';
      meta.timeEnd = state.endTime;
      meta.title = getToolTitle(state) ?? meta.title;
    }

    // For subagent tools: the subagent was just created and starts running.
    // At task:completed, pushToolInvocation creates the subagent card with
    // ChatSubagentToolInvocationData. The card shows task tool duration.
    // At child session.idle, pushFinalSubagentCard updates with full duration.
    const subagentScope = this.activeSubagentScopes.get(callID);
    if ((toolName === 'task' || toolName === 'subagent') && subagentScope) {
      const childSessionId = (state.metadata?.sessionId ??
        (typeof state.output === 'string' ? state.output.match(/task_id:\s*(\S+)/)?.[1] : undefined)) as string | undefined;
      if (childSessionId && !subagentScope.childSessionId) {
        subagentScope.childSessionId = childSessionId;
        this.log(`child session ID captured: callID=${callID}, childSessionId=${childSessionId}`);
      }
      // subAgentInvocationId already generated at task:running (scope creation)

      subagentScope.output = getToolOutput(state) ?? '';
      subagentScope.completed = true;

      this.log(`subagent scope activated (subagent spawned): callID=${callID}, childSessionId=${childSessionId || subagentScope.childSessionId}, subAgentInvocationId=${subagentScope.subAgentInvocationId}`);
      // DON'T push completed card — the subagent is still running!
      // Just update the running card to show it's active.
      // The final completed card will be pushed at child session.idle.
      if (stream.updateToolInvocation) {
        try {
          const input = state.input ?? {};
          const title = (input.description as string) ?? getToolTitle(state) ?? toolName;
          stream.updateToolInvocation(callID, {
            invocationMessage: `Running ${title}...`,
          });
        } catch { /* best-effort */ }
      }
    } else {
      // Non-subagent tools: push completed card as usual
      if (this._hasToolUI && hasChatToolInvocationPart()) {
        this.pushToolInvocation(stream, callID, toolName, state, false);
      } else {
        renderToolFallback(stream, toolName, state.input, getToolOutput(state), getToolTitle(state));
      }
    }

    this.toolMetas.delete(callID);
    this.toolCallIds.delete(partId);
    return true;
  }

  private handleToolError(
    callID: string,
    partId: string,
    toolName: string,
    state: AcpToolState,
    stream: Stream,
  ): boolean {
    // Clean up subagent scope on error
    if (toolName === 'task' || toolName === 'subagent') {
      this.activeSubagentScopes.delete(callID);
    }
    if (this._hasToolUI && hasChatToolInvocationPart()) {
      this.pushToolInvocation(stream, callID, toolName, state, true);
    } else {
      renderToolFallback(
        stream,
        toolName,
        state.input,
        state.error,
        getToolTitle(state),
      );
    }

    this.toolMetas.delete(callID);
    this.toolCallIds.delete(partId);
    return true;
  }

  // -------------------------------------------------------------------
  // ChatToolInvocationPart construction
  // -------------------------------------------------------------------

  private pushToolInvocation(
    stream: Stream,
    callID: string,
    toolName: string,
    state: AcpToolState,
    isError?: boolean,
    subAgentInvocationId?: string,
  ): void {
    const Ctor = Proposed.ChatToolInvocationPart;
    if (!Ctor) {
      renderToolFallback(stream, toolName, state.input, getToolOutput(state), getToolTitle(state));
      return;
    }

    try {
      const meta = this.toolMetas.get(callID);
      const title = getToolTitle(state) ?? meta?.title ?? toolName;
      const input = state.input ?? meta?.input ?? {};
      const output = getToolOutput(state) ?? meta?.output ?? '';
      const timeStart = state.startTime ?? meta?.timeStart;
      const timeEnd = state.endTime ?? meta?.timeEnd;

      const part = new Ctor(toolName, callID);

      if (isError) {
        part.isError = true;
        part.invocationMessage =
          state.status === 'error' && state.error
            ? state.error
            : `Tool ${toolName} failed`;
      } else {
        part.enablePartialUpdate = true;
        part.isComplete = true;
        part.invocationMessage = formatInvocationMsg(toolName, input, title);
        part.pastTenseMessage = formatPastTenseMsg(toolName, title, timeStart, timeEnd, input);
        part.toolSpecificData = buildToolSpecificData(toolName, title, input, output, timeStart, timeEnd, !!subAgentInvocationId);

        // NOTE: Parent subagent cards must NOT have subAgentInvocationId set.
        // VSCode groups child tools under the parent by matching
        // child.subAgentInvocationId === parent.toolCallId.
        // Only child tool cards should carry subAgentInvocationId.
      }

      // Hide transient tool cards after completion when a stronger/final UI exists elsewhere.
      // read/edit/write use bubble-style messages while active; edit/write also produce an
      // externalEdit checkpoint/diff that should become the primary post-completion artifact.
      if (
        toolName === 'read'
        || toolName === 'write'
        || toolName === 'edit'
        || toolName === 'internal'
        || toolName === 'step-start'
        || toolName === 'step-finish'
      ) {
        part.presentation = 'hiddenAfterComplete';
      }

      // Child tool cards carry subAgentInvocationId so VSCode groups them
      // under the parent subagent card. Parent cards must NOT have this set.
      if (subAgentInvocationId) {
        (part as any).subAgentInvocationId = subAgentInvocationId;
      }

      stream.push(part as unknown as vscode.ChatResponsePart);
    } catch {
      renderToolFallback(stream, toolName, state.input, getToolOutput(state), getToolTitle(state));
    }
  }

  // -------------------------------------------------------------------
  // Subagent scope filtering
  // -------------------------------------------------------------------

  /**
   * Check whether an OpenCode event belongs to an active subagent's internal stream.
   *
   * Event ordering (SDK-level):
   *   1. parent task:pending / task:running → scope created
   *   2. parent task:completed → childSessionId captured from metadata
   *   3. child tool events (read:pending, edit:completed, ...) arrive
   *   4. child session.idle → final progress update
   *
   * Strategy: Any `message.part.updated` whose part type is NOT `text`/`reasoning`
   * /`step-start`/`step-finish` (structural parts) and NOT a parent-level
   * `task`/`subagent` tool is treated as subagent-internal IF the part isn't
   * already tracked as a parent-level part-kind (checked via `partKinds`).
   *
   * Works with OpenCodeEvent (SDK-level), where part data is at `evt.properties.part`.
   * Uses the same `partKinds` whitelist strategy as StreamBridge.
   */
  private isSubagentInternalEvent(evt: AcpEvent): boolean {
    if (this.activeSubagentScopes.size === 0) {return false;}

    if (evt.type === 'part.updated') {
      const part = evt.part;
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
        const toolName = part.toolName;
        if (toolName === 'task' || toolName === 'subagent') {return false;}
      }
      if (this.partKinds.has(part.id)) {return false;}
      return true;
    }

    if (evt.type === 'part.delta') {
      const partId = evt.partId;
      if (partId && this.partKinds.has(partId)) {return false;}
      return !!partId;
    }

    return false;
  }

  /**
   * Push the final completed ChatToolInvocationPart for a subagent when its
   * child session goes idle. This is the ONLY place a completed card is pushed
   * for task/subagent tools — handleToolCompleted only keeps the spinner alive.
   */
  private pushFinalSubagentCard(stream: Stream, scope: SubagentScope): void {
    const meta = scope.toolMeta;
    const toolName = meta?.toolName ?? 'task';
    const title = meta?.title ?? toolName;
    const input = meta?.input ?? {};
    const output = scope.output ?? '';
    const timeStart = meta?.timeStart;
    const timeEnd = scope.timeEnd;
    const progress = formatSubagentProgress(scope);
    // Use lastText as summary if available, otherwise fall back to progress + output
    const lastText = scope.lastText?.trim();
    const result = lastText
      ? lastText
      : (progress ? [progress, output].filter(Boolean).join('\n') : output);

    // Update invocationMessage with completion status
    if (this._hasToolUI && stream.updateToolInvocation) {
      const completedCount = scope.toolCalls.filter(tc => tc.status === 'completed').length;
      let msg = `Subagent finished — ${completedCount} tool${completedCount !== 1 ? 's' : ''}`;
      if (progress) {msg += ` (${progress})`;}
      try {
        stream.updateToolInvocation(scope.callId, { invocationMessage: msg });
      } catch { /* best-effort */ }
    }

    // Push final completed tool card
    if (this._hasToolUI && hasChatToolInvocationPart() && stream.push) {
      const Ctor = Proposed.ChatToolInvocationPart;
      if (Ctor) {
        try {
          const part = new Ctor(toolName, scope.callId);
          part.enablePartialUpdate = true;
          part.isComplete = true;
          // Parent subagent card must NOT have subAgentInvocationId.
          // VSCode groups child tools under the parent by matching
          // child.subAgentInvocationId === parent.toolCallId (= scope.callId).
          part.invocationMessage = formatInvocationMsg(toolName, input, title);
          // timeStart = when task:running fired, timeEnd = when child session.idle fired
        part.pastTenseMessage = formatPastTenseMsg(toolName, title, timeStart, timeEnd, input);

          // Build ChatSubagentToolInvocationData with full result
          const description = (input.description as string) ?? title;
          const agentName = (input.agentName as string) ?? (input.agent_type as string) ?? toolName;
          const prompt = (input.prompt as string) ?? '';
          if (hasChatSubagentToolInvocationData() && Proposed.ChatSubagentToolInvocationData) {
            part.toolSpecificData = new Proposed.ChatSubagentToolInvocationData(
              description,
              agentName,
              prompt,
              result,
            );
          } else {
            part.toolSpecificData = {
              description,
              agentName,
              prompt,
              result,
            } satisfies ChatSubagentToolInvocationData;
          }

          stream.push(part as unknown as vscode.ChatResponsePart);
          this.log(`final subagent card pushed: callID=${scope.callId}, toolCalls=${scope.toolCalls.length}, progress="${progress}"`);
        } catch {
          // Best-effort; invocationMessage update above is sufficient
        }
      }
    }
  }

  /**
   *
   * Event ordering (corrected):
   *   1. parent task:completed → childSessionId is set in scope metadata
   *   2. child tool events arrive (AFTER childSessionId is already available)
   *   3. child session.idle  → final progress update
   *
   * Matches events to scope by childSessionId to correctly handle parallel subagents.
   */
  private captureSubagentEvent(evt: AcpEvent, stream?: Stream): void {
    // Handle text delta events from subagent — stream text into the subagent card
    if (evt.type === 'part.delta') {
      const delta = evt.delta;
      if (delta) {
        for (const scope of this.activeSubagentScopes.values()) {
          const currentText = (scope.lastText ?? '') + delta;
          scope.lastText = currentText;
          if (stream && this._hasToolUI && stream.updateToolInvocation) {
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

    if (evt.type !== 'part.updated') {return;}
    const part = evt.part;
    if (!part) {return;}

    // Collect text output from subagent and push to subagent card
    if (part.type === 'text') {
      const text = part.text;
      if (text && text.trim().length > 0) {
        for (const scope of this.activeSubagentScopes.values()) {
          scope.lastText = text;
          if (stream && this._hasToolUI && stream.updateToolInvocation) {
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

    if (part.type !== 'tool') {return;}

    const state = part.state;
    if (!state) {return;}

    const toolName = part.toolName ?? 'unknown';
    const title = getToolTitle(state);

    // -- Match the event to exactly one subagent scope (using childSessionId) --
    const childSessionId = part.sessionId;
    let matchedScope: SubagentScope | undefined;

    if (childSessionId) {
      for (const scope of this.activeSubagentScopes.values()) {
        if (scope.childSessionId === childSessionId) {
          matchedScope = scope;
          break;
        }
      }
      if (!matchedScope) {
        this.log(`subagent capture: no scope for childSessionId=${childSessionId}, skipping (tool=${toolName}, status=${state.status})`);
        return;
      }
    } else {
      // Graceful fallback: if sessionID is missing from the event,
      // try single-scope match (handles edge cases / race conditions).
      const scopes = [...this.activeSubagentScopes.values()];
      if (scopes.length === 1) {
        matchedScope = scopes[0];
      } else {
        this.log(`subagent capture: event missing sessionID, ${scopes.length} active scopes — skipping (tool=${toolName}, status=${state.status})`);
        return;
      }
    }

    matchedScope.toolCalls.push({
      name: toolName,
      title: title ?? undefined,
      status: state.status,
    });

    // Push real-time update so subagent activity is visible inside the card
    if (stream && this._hasToolUI && stream.updateToolInvocation) {
      const label = title ?? toolName;
      const verb = state.status === 'completed' ? '✓' : state.status === 'error' ? '✗' : '⋯';
      try {
        stream.updateToolInvocation(matchedScope.callId, { invocationMessage: `${verb} ${toolName}: ${label}` });
      } catch { /* best-effort */ }
    }

    // Forward child tool invocation to VSCode with subAgentInvocationId
    // so VSCode groups it under the parent subagent card.
    // Uses pushToolInvocation() for full toolSpecificData rendering
    // (terminal UI, file references, collapsible lists, etc.).
    if (matchedScope.subAgentInvocationId && stream) {
      const childCallId = part.callId ?? part.id ?? '';
      if (state.status === 'completed' || state.status === 'error') {
        // Push completed child tool card with full rendering
        if (this._hasToolUI && hasChatToolInvocationPart() && typeof stream.push === 'function') {
          try {
            // Register first with subAgentInvocationId
            if (stream.beginToolInvocation) {
              stream.beginToolInvocation(childCallId, toolName, {
                subagentInvocationId: matchedScope.subAgentInvocationId,
              } as any);
            }
            // Use pushToolInvocation for proper toolSpecificData
            this.pushToolInvocation(
              stream, childCallId, toolName, state,
              state.status === 'error',
              matchedScope.subAgentInvocationId,
            );
          } catch { /* best-effort */ }
        }
      } else {
        // Running/pending: just register via beginToolInvocation
        if (this._hasToolUI && stream.beginToolInvocation) {
          try {
            stream.beginToolInvocation(childCallId, toolName, {
              subagentInvocationId: matchedScope.subAgentInvocationId,
            } as any);
          } catch { /* best-effort */ }
        }
      }
    }

    this.log(
      `subagent capture: tool=${part.toolName}, status=${state.status}, ` +
      `childSessionId=${childSessionId ?? '<none>'}, callID=${matchedScope.callId}`,
    );
  }

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

  private log(message: string): void {
    this.logger?.appendLine(`[acp-renderer] ${message}`);
  }
}

// =======================================================================
// Pure helper functions (exported for reuse in experimental surfaces)
// =======================================================================

/**
 * Build tool-specific data for a `ChatToolInvocationPart` based on tool
 * name and invocation state.
 */
export function buildToolSpecificData(
  toolName: string,
  title: string,
  input: Record<string, unknown>,
  output: string,
  timeStart?: number,
  timeEnd?: number,
  isSubagentTool?: boolean,
): ChatToolSpecificData | undefined {
  switch (toolName) {
    case 'bash':
    case 'shell': {
      const lang =
        (input.language as string) ?? detectLanguage(title) ?? 'bash';
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
        // No expandable result — just a clickable file link in invocationMessage
        return undefined;
      }

      case 'list':
      case 'grep':
      case 'grep_app_searchGitHub': {
        // Show as collapsible file references list (matches VSCode Copilot search pattern)
        const values: Array<vscode.Uri | vscode.Location> = [];
        const path = input.path as string | undefined;
        if (path) {
          values.push(vscode.Uri.file(path));
        }
        // If output has file paths, try to extract them as Location objects
        if (output) {
          const lines = output.split('\n');
          for (const line of lines) {
            const fileMatch = line.match(/^[A-Za-z]:\\(?:[^\\]+\\)*[^:]+|^\/(?:[^\/]+\/)*[^:]+/);
            if (fileMatch) {
              try {
                values.push(vscode.Uri.file(fileMatch[0]));
              } catch {
                // skip invalid paths
              }
            }
          }
        }
        if (values.length > 0) {
          return { values } satisfies ChatToolResourcesInvocationData;
        }
        return {
          input: formatInput(input, title),
          output: truncate(output, 2000),
        } satisfies ChatSimpleToolResultData;
      }

      case 'fetch':
      case 'webfetch': {
        return {
          input: formatInput(input, title),
          output: truncate(output, 2000),
        } satisfies ChatSimpleToolResultData;
      }

      case 'websearch':
      case 'websearch_web_search_exa': {
        // Show as clickable web URL references
        const values: Array<vscode.Uri | vscode.Location> = [];
        const query = input.query as string | undefined;
        if (query) {
          // Add a web search URL as reference
          values.push(vscode.Uri.parse(`https://www.bing.com/search?q=${encodeURIComponent(query)}`));
        }
        // Parse output for URLs
        if (output) {
          const urlRegex = /https?:\/\/[^\s"')>]+/g;
          let match;
          while ((match = urlRegex.exec(output)) !== null) {
            try {
              values.push(vscode.Uri.parse(match[0]));
            } catch {
              // skip invalid URLs
            }
          }
        }
        if (values.length > 0) {
          return { values } satisfies ChatToolResourcesInvocationData;
        }
        return {
          input: formatInput(input, title),
          output: truncate(output, 2000),
        } satisfies ChatSimpleToolResultData;
      }

      case 'write':
      case 'edit': {
        // For edit/write we intentionally avoid resources cards here.
        // Running/completed messages already use file bubbles, and the final edit UI should
        // be represented by ChatResponseExternalEditPart instead of a duplicate resources list.
        return undefined;
      }

    case 'list':
    case 'grep':
    case 'grep_app_searchGitHub': {
      return {
        input: formatInput(input, title),
        output: truncate(output, 2000),
      } satisfies ChatSimpleToolResultData;
    }

    case 'fetch':
    case 'webfetch': {
      return {
        input: formatInput(input, title),
        output: truncate(output, 2000),
      } satisfies ChatSimpleToolResultData;
    }

    case 'websearch':
    case 'websearch_web_search_exa': {
      return {
        input: formatInput(input, title),
        output: truncate(output, 2000),
      } satisfies ChatSimpleToolResultData;
    }

    case 'todowrite':
    case 'todo': {
      const todos = input.todos as Array<{ content: string; status: string }> | undefined;
      if (todos && Array.isArray(todos)) {
        if (isSubagentTool) {
          // Subagent: use formatted text fallback like "[x] 1. done\n[ ] 2. pending"
          const formatted = todos.map((item, idx) => {
            const check = item.status === 'completed' ? 'x' : ' ';
            return `[${check}] ${idx + 1}. ${item.content}`;
          }).join('\n');
          return {
            input: formatted,
            output: truncate(output, 2000),
          } satisfies ChatSimpleToolResultData;
        }
        // Root session: use proper ChatTodoToolInvocationData
        const todoList = todos.map((item, idx) => ({
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
      return {
        input: formatInput(input, title),
        output: truncate(output, 2000),
      } satisfies ChatSimpleToolResultData;
    }

    case 'task':
    case 'subagent': {
      const description = (input.description as string) ?? title;
      const agentName = (input.agentName as string) ?? (input.agent_type as string) ?? title ?? toolName;
      const prompt = (input.prompt as string) ?? formatInput(input, '');
      const result = truncate(output, 4000);

      if (hasChatSubagentToolInvocationData() && Proposed.ChatSubagentToolInvocationData) {
        return new Proposed.ChatSubagentToolInvocationData(
          description,
          agentName,
          prompt,
          result,
        );
      }

      return {
        description,
        agentName,
        prompt,
        result,
      } satisfies ChatSubagentToolInvocationData;
    }

    default: {
      if (Object.keys(input).length > 0 || output) {
        return {
          input: formatInput(input, title),
          output: truncate(output, 2000),
        } satisfies ChatSimpleToolResultData;
      }
      return undefined;
    }
  }
}

/**
 * Format a human-readable "invocation message" shown while a tool is running.
 * read → `[fileName](file://path)` markdown link
 * grep → `` Searching `pattern` ``
 * grep_app_searchGitHub → `` Github Searching `query` ``
 * websearch/websearch_web_search_exa → `` Web Searching `query` ``
 */
export function formatInvocationMsg(
  toolName: string,
  input: Record<string, unknown>,
  title: string,
): string | vscode.MarkdownString {
  const formatFileBubbleMessage = (
    verb: 'Read' | 'Editing' | 'Writing',
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
    return new vscode.MarkdownString(`${verb} [](${uri}${range})${lineInfo}${suffix}`);
  };

  // --- read: official-style file bubble ---
  //
  // Keep this logic in sync with participant/streaming.ts.
  // Research outcome:
  // - Initial MarkdownString `Read [](${uri}#range)` can render as the same style of
  //   file bubble seen in Copilot-like read/view cards.
  // - The fragile part is NOT the initial push; it is the completed-state rewrite.
  // - If completed-state `pastTenseMessage` falls back to plain text, the bubble is
  //   replaced by normal text.
  // Therefore both running and completed read messages must stay in bubble Markdown.
  if (toolName === 'read') {
    const filePath = input.filePath as string | undefined;
    if (filePath) {
      let lineInfo = '';
      const offset = input.offset as number | undefined;
      const limit = input.limit as number | undefined;
      if (offset != null || limit != null) {
        const start = offset ?? 1;
        const end = limit != null ? start + limit - 1 : undefined;
        lineInfo = end != null ? ` line ${start}-${end}` : ` line ${start}`;
      }
      return formatFileBubbleMessage('Read', filePath, offset, limit);
    }
  }

  // edit/write keep the same bubble style while running. The actual file-change checkpoint
  // still comes from externalEdit, so this message is descriptive UI, not the diff payload.
  if (toolName === 'edit' || toolName === 'write') {
    const filePath = input.filePath as string | undefined;
    if (filePath) {
      const offset = input.offset as number | undefined;
      const limit = input.limit as number | undefined;
      const lineCount = limit ?? 1;
      const verb = toolName === 'edit' ? 'Editing' : 'Writing';
      return formatFileBubbleMessage(verb, filePath, offset, limit, ` (${lineCount} lines)`);
    }
  }

  // --- grep: Searching `pattern` ---
  if (toolName === 'grep') {
    const pattern = (input.pattern as string) ?? (input.query as string) ?? title;
    if (pattern) {
      const short = pattern.length > 80 ? pattern.substring(0, 77) + '...' : pattern;
      return new vscode.MarkdownString(`Searching \`${short}\``);
    }
  }

  // --- grep_app_searchGitHub: Github Searching `query` ---
  if (toolName === 'grep_app_searchGitHub') {
    const query = (input.query as string) ?? title;
    if (query) {
      const short = query.length > 80 ? query.substring(0, 77) + '...' : query;
      return new vscode.MarkdownString(`Github Searching \`${short}\``);
    }
  }

  // --- fetch / webfetch: show URL ---
  if (toolName === 'fetch' || toolName === 'webfetch') {
    const url = (input.url as string) ?? title;
    if (url) {
      const short = url.length > 80 ? url.substring(0, 77) + '...' : url;
      return new vscode.MarkdownString(`Fetching [${short}](${short})`);
    }
  }

  // --- websearch_web_search_exa: Web Searching `query` ---
  if (toolName === 'websearch' || toolName === 'websearch_web_search_exa') {
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
  const short =
    typeof firstVal === 'string'
      ? firstVal.length > 60
        ? firstVal.substring(0, 57) + '...'
        : firstVal
      : JSON.stringify(firstVal);
  return `Running ${display} (${firstKey}: ${short})`;
}

/**
 * Format a human-readable "past tense message" shown after a tool completes.
 * Shows search parameters in title for grep/websearch tools.
 */
export function formatPastTenseMsg(
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
  // This is required to preserve the bubble after the tool transitions to `isComplete`.
  if (toolName === 'read') {
    const filePath = input?.filePath as string | undefined;
    if (filePath) {
      const offset = input?.offset as number | undefined;
      const limit = input?.limit as number | undefined;
      return formatFileBubbleMessage('Read', filePath, offset, limit);
    }
    return `${title}${duration}`;
  }

  // Preserve bubble styling after completion too; otherwise completed-state text can replace
  // the running bubble before the externalEdit visualization becomes the primary output.
  if (toolName === 'edit' || toolName === 'write') {
    const filePath = input?.filePath as string | undefined;
    if (filePath) {
      const offset = input?.offset as number | undefined;
      const limit = input?.limit as number | undefined;
      const lineCount = limit ?? 1;
      const verb = toolName === 'edit' ? 'Edited' : 'Wrote';
      return formatFileBubbleMessage(verb, filePath, offset, limit, ` (${lineCount} lines)`);
    }
  }

  // --- grep: Searched `pattern` ---
  if (toolName === 'grep') {
    const pattern = input ? (input.pattern as string) ?? (input.query as string) ?? title : title;
    return `Searched \`${pattern}\`${duration}`;
  }

  // --- grep_app_searchGitHub: Github Searched `query` ---
  if (toolName === 'grep_app_searchGitHub') {
    const query = input ? (input.query as string) ?? title : title;
    return `Github Searched \`${query}\`${duration}`;
  }

  // --- websearch / websearch_web_search_exa: Web Searched `query` ---
  if (toolName === 'websearch' || toolName === 'websearch_web_search_exa') {
    const query = input ? (input.query as string) ?? title : title;
    return `Web Searched \`${query}\`${duration}`;
  }

  const pastVerb =
    ({
      read: 'Read',
      bash: 'Ran',
      write: 'Wrote',
      list: 'Listed',
      grep: 'Searched',
      grep_app_searchGitHub: 'Github Searched',
      edit: 'Edited',
      task: 'Completed subagent',
      subagent: 'Completed subagent',
      fetch: 'Fetched',
      webfetch: 'Fetched',
      websearch: 'Web Searched',
      websearch_web_search_exa: 'Web Searched',
      todowrite: 'Updated todos',
      todo: 'Updated todos',
    } as Record<string, string>)[toolName] ?? 'Executed';

  return `${pastVerb} ${title}${duration}`;
}

/**
 * Render a tool result using only stable markdown() — no proposed APIs.
 */
export function renderToolFallback(
  stream: vscode.ChatResponseStream,
  toolName: string,
  input: Record<string, unknown> | undefined,
  output: string | undefined,
  title?: string,
): void {
  const display = title ?? toolName;
  const inputLine =
    input && Object.keys(input).length > 0
      ? Object.entries(input)
          .map(([k, v]) =>
            typeof v === 'string'
              ? `**${k}**: \`${v}\``
              : `**${k}**: \`${JSON.stringify(v)}\``,
          )
          .join(', ')
      : '';

  stream.markdown(`\n\u{1F527} **${display}** \`${toolName}\``);
  if (inputLine) {stream.markdown(` — ${inputLine}`);}
  if (output) {
    stream.markdown(`\n\`\`\`\n${truncate(output, 300)}\n\`\`\`\n`);
  }
  stream.markdown('\n');
}

// =======================================================================
// Shared pure utilities
// =======================================================================

/** Truncate text to `maxLen` characters, appending '…' if truncated. */
export function truncate(text: string, maxLen: number): string {
  if (!text || text.length <= maxLen) {return text;}
  return text.substring(0, maxLen) + '\u2026';
}

/** Format tool input as a human-readable string. */
export function formatInput(
  input: Record<string, unknown>,
  fallback: string,
): string {
  if (!input || Object.keys(input).length === 0) {return fallback;}
  return Object.entries(input)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
}

/** Heuristic language detection from tool title (e.g. "script.py"). */
export function detectLanguage(title: string): string {
  const m = title.match(/\.(\w+)$/);
  if (m) {
    const ext = m[1];
    const map: Record<string, string> = {
      sh: 'bash',
      py: 'python',
      js: 'javascript',
      ts: 'typescript',
      ps1: 'powershell',
      rb: 'ruby',
      go: 'go',
      rs: 'rust',
      java: 'java',
    };
    return map[ext] ?? ext;
  }
  return 'bash';
}

function getToolTitle(state: AcpToolState): string | undefined {
  return 'title' in state ? state.title : undefined;
}

function getToolOutput(state: AcpToolState): string | undefined {
  return 'output' in state ? state.output : undefined;
}

function getToolTime(
  state: AcpToolState,
): { start?: number; end?: number } | undefined {
  if (state.startTime != null || state.endTime != null) {
    return { start: state.startTime, end: state.endTime };
  }
  return undefined;
}

