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
 *   read          → ChatSimpleToolResultData (collapsible input/output)
 *   bash          → ChatTerminalToolInvocationData (terminal UI with exit code)
 *   write         → ChatToolResourcesInvocationData (file reference list)
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
  private readonly logger?: StreamBridgeLogger;
  private readonly sessionId?: string;
  /** URIs of files that existed before the turn started (proactive baseline) */
  private knownFileUris: Set<string>;
  private readonly tracker?: ExternalEditTracker;
  private readonly replyToPermission?: StreamBridgeOptions['replyToPermission'];
  private readonly directory?: string;

  constructor(options: StreamBridgeOptions = {}) {
    this.logger = options.logger;
    this.sessionId = options.sessionId;
    this.knownFileUris = options.knownFileUris ?? new Set();
    this.tracker = options.tracker;
    this.replyToPermission = options.replyToPermission;
    this.directory = options.directory;
  }

  /** Get the OpenCode message ID of the user message in this turn, if captured */
  getUserMessageId(): string | null {
    return this.userMessageId;
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

    try {
      for await (const event of events) {
        if (token.isCancellationRequested) {
          const msg = 'Operation cancelled';
          this.log('bridge stop: cancellation requested');
          stream.markdown(`\n⚠️ ${msg}\n`);
          break;
        }
        const tEnter = Date.now();
        // Handle permission.asked as sync barrier (async, blocks loop until baseline captured + auto-reply)
        if (event.type === 'permission.asked') {
          await this.handlePermissionAsked(event, stream);
          const tPerm = Date.now();
          this.log(`[timing] permission.asked took ${tPerm - tEnter}ms`);
          continue;
        }
        const result = this.processEvent(event, s);
        const tProcessed = Date.now();
        this.log(`[timing] processEvent: type=${event.type}, rendered=${result.rendered}, took ${tProcessed - tEnter}ms`);
        if (result.rendered) {
          await yieldToEventLoop();
          this.log(`[timing] yieldToEventLoop resolved, total=${Date.now() - tEnter}ms`);
        }
        if (result.stop) {
          this.log('bridge stop: session.idle received');
          break;
        }
      }
      this.log('bridge loop completed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection lost';
      this.log(`bridge error: ${msg}`);
      stream.markdown(`\n⚠️ ${msg}\n`);
    } finally {
      this.log(
        `bridge reset: userMessageId=${this.userMessageId ?? 'null'}, ` +
        `partKinds=${this.partKinds.size}, toolMetas=${this.toolMetas.size}`,
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

    switch (event.type) {
      case 'part.updated':
        return { stop: false, rendered: this.handlePartUpdated(event, stream) };
      case 'part.delta':
        return { stop: false, rendered: this.handlePartDelta(event, stream) };
      case 'session.idle':
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
      case 'session.idle': {
        const eventSessionId = getEventSessionId(evt);
        return !eventSessionId || eventSessionId === this.sessionId;
      }
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

      // Set subAgentInvocationId for task/subagent tools
      if (toolName === 'task' || toolName === 'subagent') {
        part.subAgentInvocationId = callID;
      }

      // Set presentation for internal/structural tools
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

  private reset(): void {
    // userMessageId intentionally NOT reset — caller reads it after bridging
    this.partKinds.clear();
    this.toolCallIds.clear();
    this.toolMetas.clear();
    this.progressivePushed.clear();
    this.assistantPhaseStarted = false;
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
      return evt.sessionId;
    default:
      return undefined;
  }
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
