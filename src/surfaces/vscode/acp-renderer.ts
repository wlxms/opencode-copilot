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
  MessagePartUpdatedEvent,
  SessionDiffEvent,
  OpenCodeEvent,
  TextStreamPart,
  ReasoningStreamPart,
  StreamToolPart,
  StreamToolState,
} from '../../backends/opencode/sdk-events';

import type {
  ChatTerminalToolInvocationData,
  ChatSimpleToolResultData,
  ChatToolResourcesInvocationData,
  ChatSubagentToolInvocationData,
  ChatToolSpecificData,
  ChatToolInvocationPart,
  ChatToolInvocationStreamData,
  ChatResponseDiffEntry,
  ChatResponseMultiDiffPart,
} from '../../types/vscode-proposed-additions';

import {
  hasThinkingProgress,
  hasToolUI,
  hasChatToolInvocationPart,
  hasChatResponseMultiDiffPart,
  hasChatSubagentToolInvocationData,
} from './capabilities';

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
  renderEvent(evt: OpenCodeEvent, stream: vscode.ChatResponseStream): RenderResult {
    const s = stream as Stream;

    switch (evt.type) {
      case 'message.part.updated':
        return {
          rendered: this.handlePartUpdated(evt, s),
          eventType: 'message.part.updated',
        };
      case 'message.part.delta':
        return {
          rendered: this.handlePartDelta(evt, s),
          eventType: 'message.part.delta',
        };
      case 'session.idle':
        return { rendered: false, eventType: 'session.idle' };
      case 'session.diff':
        return {
          rendered: this.handleSessionDiff(evt as SessionDiffEvent, s),
          eventType: 'session.diff',
        };
      case 'permission.asked':
        // Permission events are wire-protocol concerns — no rendering needed
        return { rendered: false, eventType: 'permission.asked' };
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
   * Whether the assistant phase has started (first reasoning/tool/step event seen).
   */
  isAssistantPhaseStarted(): boolean {
    return this.assistantPhaseStarted;
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
  private handlePartUpdated(evt: MessagePartUpdatedEvent, stream: Stream): boolean {
    const part = evt.properties?.part;
    if (!part) return false;

    switch (part.type) {
      case 'text': {
        const textPart = part as TextStreamPart;
        const msgId = textPart.messageID;
        // Capture user message ID on first text part
        if (
          !this.assistantPhaseStarted &&
          !this.userMessageId &&
          textPart.text.length > 0
        ) {
          this.userMessageId = msgId;
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
        const reasoningPart = part as ReasoningStreamPart;
        this.partKinds.set(reasoningPart.id, 'reasoning');
        return false;
      }

      case 'tool': {
        this.assistantPhaseStarted = true;
        const toolPart = part as StreamToolPart;
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
    evt: Extract<OpenCodeEvent, { type: 'message.part.delta' }>,
    stream: Stream,
  ): boolean {
    const props = evt.properties;
    if (!props?.delta) return false;

    const partID = props.partID;
    const delta = props.delta;
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
  private handleSessionDiff(evt: SessionDiffEvent, stream: Stream): boolean {
    const diffs = evt.properties?.diff;
    if (!diffs?.length) return false;

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

    if (!entries.length) return false;

    const Ctor = Proposed.ChatResponseMultiDiffPart;
    if (!Ctor) return false;

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
  private handleToolState(part: StreamToolPart, stream: Stream): boolean {
    const state = part.state;
    if (!state) return false;

    const toolName = part.tool ?? 'unknown';
    const callID = part.callID ?? part.id;
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
    state: StreamToolState,
    stream: Stream,
  ): boolean {
    const meta = this.toolMetas.get(callID);
    if (meta) {
      meta.input = state.input ?? {};
      meta.title = getToolTitle(state);
      meta.timeStart = getToolTime(state)?.start;
    }

    if (!this._hasToolUI || !stream.updateToolInvocation) {
      return false;
    }

    stream.updateToolInvocation(callID, {
      partialInput: state.input ?? {},
    });

    // Progressive push: show a "tool running" spinner in the UI
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
          part.invocationMessage = formatInvocationMsg(
            toolName,
            state.input ?? {},
            getToolTitle(state) ?? toolName,
          );
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
    state: StreamToolState,
    stream: Stream,
  ): boolean {
    const meta = this.toolMetas.get(callID);
    if (meta) {
      meta.output = getToolOutput(state) ?? '';
      meta.timeEnd = getToolTime(state)?.end;
      meta.title = getToolTitle(state) ?? meta.title;
    }

    if (this._hasToolUI && hasChatToolInvocationPart()) {
      this.pushToolInvocation(stream, callID, toolName, state);
    } else {
      renderToolFallback(stream, toolName, state.input, getToolOutput(state), getToolTitle(state));
    }

    this.toolMetas.delete(callID);
    this.toolCallIds.delete(partId);
    return true;
  }

  private handleToolError(
    callID: string,
    partId: string,
    toolName: string,
    state: StreamToolState,
    stream: Stream,
  ): boolean {
    if (this._hasToolUI && hasChatToolInvocationPart()) {
      this.pushToolInvocation(stream, callID, toolName, state, true);
    } else {
      renderToolFallback(
        stream,
        toolName,
        state.input,
        'error' in state ? state.error : undefined,
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
    state: StreamToolState,
    isError?: boolean,
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
      const time = getToolTime(state);
      const timeStart = time?.start ?? meta?.timeStart;
      const timeEnd = time?.end ?? meta?.timeEnd;

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
        part.pastTenseMessage = formatPastTenseMsg(toolName, title, timeStart, timeEnd);
        part.toolSpecificData = buildToolSpecificData(toolName, title, input, output, timeStart, timeEnd);
      }

      // Link subagent tools
      if (toolName === 'task' || toolName === 'subagent') {
        part.subAgentInvocationId = callID;
      }

      // Hide internal/structural tools after completion
      if (toolName === 'internal' || toolName === 'step-start' || toolName === 'step-finish') {
        part.presentation = 'hiddenAfterComplete';
      }

      stream.push(part as unknown as vscode.ChatResponsePart);
    } catch {
      renderToolFallback(stream, toolName, state.input, getToolOutput(state), getToolTitle(state));
    }
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

    case 'read':
    case 'list':
    case 'grep': {
      return {
        input: formatInput(input, title),
        output: truncate(output, 2000),
      } satisfies ChatSimpleToolResultData;
    }

    case 'write':
    case 'edit': {
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

    case 'task':
    case 'subagent': {
      const description = (input.description as string) ?? title;
      const agentName = (input.agentName as string) ?? toolName;
      const prompt = (input.prompt as string) ?? formatInput(input, '');
      const result = truncate(output, 4000);

      if (hasChatSubagentToolInvocationData() && Proposed.ChatSubagentToolInvocationData) {
        return new Proposed.ChatSubagentToolInvocationData(
          description,
          agentName,
          prompt,
          result,
        ) as ChatSubagentToolInvocationData;
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
 */
export function formatInvocationMsg(
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
 */
export function formatPastTenseMsg(
  toolName: string,
  title: string,
  timeStart?: number,
  timeEnd?: number,
): string {
  const display = title || toolName;
  const pastVerb =
    ({
      read: 'Read',
      bash: 'Ran',
      write: 'Wrote',
      list: 'Listed',
      grep: 'Searched',
      edit: 'Edited',
      task: 'Completed subagent',
    } as Record<string, string>)[toolName] ?? 'Executed';
  let msg = `${pastVerb} ${display}`;
  if (timeStart != null && timeEnd != null) {
    const dur = ((timeEnd - timeStart) / 1000).toFixed(1);
    msg += ` (${dur}s)`;
  }
  return msg;
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
  if (inputLine) stream.markdown(` — ${inputLine}`);
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
  if (!text || text.length <= maxLen) return text;
  return text.substring(0, maxLen) + '\u2026';
}

/** Format tool input as a human-readable string. */
export function formatInput(
  input: Record<string, unknown>,
  fallback: string,
): string {
  if (!input || Object.keys(input).length === 0) return fallback;
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

function getToolTitle(state: StreamToolState): string | undefined {
  return 'title' in state ? state.title : undefined;
}

function getToolOutput(state: StreamToolState): string | undefined {
  return 'output' in state ? state.output : undefined;
}

function getToolTime(
  state: StreamToolState,
): { start?: number; end?: number } | undefined {
  return 'time' in state ? state.time : undefined;
}
