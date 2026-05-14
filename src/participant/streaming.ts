import * as vscode from 'vscode';
import type {
  MessagePartUpdatedEvent,
  OpenCodeEvent,
  OpenCodeEventStream,
  OpenCodeStreamEvent,
  PermissionAskedEvent,
  ReasoningStreamPart,
  StreamToolPart,
  StreamToolState,
  TextStreamPart,
  ToolCallStatus,
} from '../types/events';
import type { CheckpointMode } from '../config';
import type {
  ChatTerminalToolInvocationData,
  ChatSimpleToolResultData,
  ChatToolResourcesInvocationData,
  ChatSubagentToolInvocationData,
  ChatToolSpecificData,
  ChatToolInvocationPart,
  ChatToolInvocationStreamData,
  ChatWorkspaceFileEdit,
  ChatResponseExternalEditPart,
  ChatResponseWorkspaceEditPart,
} from '../types/vscode-proposed-additions';

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
  /** Checkpoint supervision mode */
  checkpointMode?: CheckpointMode;
  /** Called when a permission.asked SSE event arrives (permission mode) */
  onPermissionAsked?: (permission: { id: string; sessionID: string; type: string; metadata: Record<string, unknown> }) => void | Promise<void>;
  /** Called when a tool reaches completed status (message mode checkpoint boundary) */
  onToolCompleted?: (toolName: string, callID: string) => void;
  /** Called at checkpoint cycle boundaries to signal the ExternalEditPart callback. */
  onCheckpointCycle?: () => void | Promise<void>;
  /** Called when an edit/write tool touches a file. Receives the file URI so the handler can include it in subsequent ExternalEditPart pushes. */
  onToolEditFile?: (uri: vscode.Uri) => void;
}

// =======================================================================
// StreamBridge
// =======================================================================

/**
 * Bridges OpenCode SSE events to a VSCode ChatResponseStream.
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
  /** Tracks which callIDs have already triggered a checkpoint signal at running —
   *  prevents duplicate signals when the server emits multiple running events
   *  for the same tool call (e.g., partial input updates). */
  private checkpointSignaled: Set<string> = new Set();
  private readonly logger?: StreamBridgeLogger;
  private readonly sessionId?: string;
  /** URIs of files that existed before the turn started (proactive baseline) */
  private knownFileUris: Set<string>;
  private readonly checkpointMode?: CheckpointMode;
  private readonly onPermissionAsked?: (permission: { id: string; sessionID: string; type: string; metadata: Record<string, unknown> }) => void | Promise<void>;
  private readonly onToolCompleted?: (toolName: string, callID: string) => void;
  private readonly onCheckpointCycle?: () => void | Promise<void>;
  private readonly onToolEditFile?: (uri: vscode.Uri) => void;
  private textDeltaLogged = 0;

  constructor(options: StreamBridgeOptions = {}) {
    this.logger = options.logger;
    this.sessionId = options.sessionId;
    this.knownFileUris = options.knownFileUris ?? new Set();
    this.checkpointMode = options.checkpointMode;
    this.onPermissionAsked = options.onPermissionAsked;
    this.onToolCompleted = options.onToolCompleted;
    this.onCheckpointCycle = options.onCheckpointCycle;
    this.onToolEditFile = options.onToolEditFile;
  }

  /** Get the OpenCode message ID of the user message in this turn, if captured */
  getUserMessageId(): string | null {
    return this.userMessageId;
  }

  async bridgeEventsToStream(
    events: OpenCodeEventStream,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<boolean> {
    const s = stream as Stream;
    this.hasThinking = typeof s.thinkingProgress === 'function';
    this.hasToolUI = typeof s.beginToolInvocation === 'function';
    this.log(
      `bridge start: hasThinking=${this.hasThinking}, hasToolUI=${this.hasToolUI}, ` +
      `tokenCancelled=${token.isCancellationRequested}, targetSession=${this.sessionId ?? 'any'}`,
    );

    try {
      for await (const rawEvt of events.stream) {
        const evt = unwrapStreamEvent(rawEvt);
        if (evt.type !== 'message.part.delta') {
          this.log(`event: ${describeStreamEvent(rawEvt, evt)}`);
        }
        if (token.isCancellationRequested) {
          const msg = 'Operation cancelled';
          this.log('bridge stop: cancellation requested');
          stream.markdown(`\n⚠️ ${msg}\n`);
          break;
        }
        const result = await this.processEvent(evt, s, token);
        if (result.rendered) {
          await yieldToEventLoop();
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

  // -------------------------------------------------------------------
  // Event dispatch
  // -------------------------------------------------------------------

  private async processEvent(evt: OpenCodeEvent, stream: Stream, token: vscode.CancellationToken): Promise<EventDispatchResult> {
    if (!this.shouldProcessEvent(evt)) {
      const eventSessionId = getEventSessionId(evt);
      this.log(
        `skip event: type=${evt.type}, sessionID=${eventSessionId ?? 'unknown'}, ` +
        `target=${this.sessionId ?? 'any'}`,
      );
      return { stop: false, rendered: false };
    }

    if (evt.type === 'permission.asked') {
      const p = evt.properties;
      this.log(
        `process permission.asked: permissionID=${p.id}, sessionID=${p.sessionID}, ` +
        `permission=${p.permission}, callID=${p.tool?.callID ?? 'none'}, target=${this.sessionId ?? 'any'}`,
      );
    }

    switch (evt.type) {
      case 'message.part.updated':
        return { stop: false, rendered: await this.handlePartUpdated(evt, stream, token) };
      case 'message.part.delta':
        return { stop: false, rendered: this.handlePartDelta(evt, stream) };
      case 'session.idle':
        return { stop: true, rendered: false };
      case 'permission.asked':
        return { stop: false, rendered: await this.handlePermissionAsked(evt, token) };
    }
    return { stop: false, rendered: false };
  }

  // -------------------------------------------------------------------
  // message.part.updated
  // -------------------------------------------------------------------

  private async handlePartUpdated(evt: MessagePartUpdatedEvent, stream: Stream, token: vscode.CancellationToken): Promise<boolean> {
    const part = evt.properties?.part;
    if (!part) return false;

    this.log(`part.updated: ${describePart(part)}`);

    switch (part.type) {
      case 'text': {
        const textPart = part as TextStreamPart;
        const msgId = textPart.messageID;
        if (!this.assistantPhaseStarted && !this.userMessageId && textPart.text && textPart.text.length > 0) {
          this.userMessageId = msgId;
          this.log(`captured userMessageId=${msgId}`);
          return false;
        }
        if (msgId !== this.userMessageId || !this.userMessageId) {
          this.partKinds.set(textPart.id, 'text');
          this.log(`registered text part id=${textPart.id}, messageID=${msgId}`);
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
        return this.handleToolState(toolPart, stream, token);
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
  // message.part.delta
  // -------------------------------------------------------------------

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
      this.log(`part.delta: partID=${partID}, kind=reasoning, len=${delta.length}`);
      if (this.hasThinking && stream.thinkingProgress) {
        stream.thinkingProgress({ text: delta, id: partID });
        return true;
      }
    } else if (kind === 'text') {
      this.textDeltaLogged += delta.length;
      if (this.textDeltaLogged >= 100) {
        this.log(`part.delta: kind=text, batch=${delta.length}, total=${this.textDeltaLogged}`);
        this.textDeltaLogged = 0;
      }
      stream.markdown(delta);
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------
  // permission.asked (permission-mode checkpoint boundary)
  // -------------------------------------------------------------------

  /**
   * Handles `permission.asked` events emitted by the OpenCode server
   * when a tool requires approval before proceeding.
   *
   * In permission mode the server blocks execution until we reply via
   * POST /session/{id}/permissions/{permissionID}. We use that pause to
   * start the checkpoint for the target file before sending the approval.
   */
  private async handlePermissionAsked(evt: PermissionAskedEvent, token: vscode.CancellationToken): Promise<boolean> {
    const p = evt.properties;
    this.log(`permission.asked: id=${p.id} sessionID=${p.sessionID} permission=${p.permission} callID=${p.tool?.callID ?? 'none'}`);
    this.log(
      `permission.asked metadata: keys=${Object.keys(p.metadata ?? {}).join(',') || 'none'}, ` +
      `patterns=${Array.isArray(p.patterns) ? p.patterns.join('|') : 'none'}, always=${p.always.join('|') || 'none'}`,
    );

    // Pre-register the file being edited BEFORE approving.
    // The server is blocked here — the file hasn't been modified yet.
    // Extract file path from permission metadata or pattern.
    this.preregisterFileFromPermission(p);

    if (this.checkpointMode === 'permission' && p.permission === 'edit' && this.onCheckpointCycle) {
      await this.onCheckpointCycle();
      this.log(`[bridge] checkpoint signal: mode=permission, at=permission.asked (callID=${p.tool?.callID ?? 'none'})`);
    }

    if (this.checkpointMode === 'permission' && this.onPermissionAsked) {
      try {
        this.log(`permission.asked: approving permissionID=${p.id}`);
        await this.onPermissionAsked({
          id: p.id,
          sessionID: p.sessionID,
          type: p.permission,
          metadata: p.metadata,
        });
        this.log(`permission.asked: approved permissionID=${p.id}`);
      } catch (err: unknown) {
        this.log(`permission auto-approve error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Pre-register file from permission metadata so the next ExternalEditPart
    // can target the file before the server resumes the edit.
    return false; // no UI rendering for permission events
  }

  /**
   * Extract file path from a permission event and pre-register it.
    * The server is blocked at this point — the file hasn't been modified yet.
    * Tries metadata.file_path, metadata.filePath, metadata.path, and patterns[0].
   */
  private preregisterFileFromPermission(p: { metadata: Record<string, unknown>; patterns?: string[]; permission: string }): void {
    if (!this.onToolEditFile) return;
    if (p.permission !== 'edit' && p.permission !== 'write') return;

    // Try common metadata keys for the file path
    const filePath =
      (p.metadata.file_path as string | undefined) ??
      (p.metadata.filePath as string | undefined) ??
      (p.metadata.path as string | undefined) ??
      ((p.patterns?.length === 1) ? p.patterns[0] : undefined);

    if (filePath) {
      this.onToolEditFile(vscode.Uri.file(filePath));
      this.log(`pre-registered file for checkpoint: ${filePath} (at=permission.asked)`);
    }
  }

  // -------------------------------------------------------------------
  // Tool call state machine: pending → running → completed
  // -------------------------------------------------------------------

  private async handleToolState(part: StreamToolPart, stream: Stream, token: vscode.CancellationToken): Promise<boolean> {
    const state = part.state;
    if (!state) return false;

    const toolName = part.tool ?? 'unknown';
    const callID = part.callID ?? part.id;
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

      // Pre-register the file being edited BEFORE the edit happens.
      // In message mode this is the earliest point where input.filePath is available.
      // The file hasn't been modified on disk yet at this stage.
      if ((toolName === 'edit' || toolName === 'write') && this.onToolEditFile) {
        const input = state.input as Record<string, unknown> | undefined;
        const filePath = input?.filePath as string | undefined;
        if (filePath) {
          this.onToolEditFile(vscode.Uri.file(filePath));
          this.log(`pre-registered file for checkpoint: ${filePath} (at=${toolName}.running)`);
        }
      }
      // Signal checkpoint boundary at tool.running only in message mode.
      // Permission mode already starts its snapshot at permission.asked.
      if (this.checkpointMode === 'message' && (toolName === 'edit' || toolName === 'write')
          && this.onCheckpointCycle && !this.checkpointSignaled.has(callID)) {
        this.checkpointSignaled.add(callID);
        this.onCheckpointCycle();
        this.log(`[bridge] checkpoint signal: mode=message, at=${toolName}.running (callID=${callID})`);
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
      return false;
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
      // Track file changes via ChatResponseWorkspaceEditPart (both new and edited files)
      if (toolName === 'edit' || toolName === 'write') {
        const input = state.input as Record<string, unknown> | undefined;
        const filePath = input?.filePath as string | undefined;
        if (filePath && VS.ChatResponseWorkspaceEditPart && stream.push) {
          if (toolName === 'write') {
            const fileUri = vscode.Uri.file(filePath).toString();
            const isNewFile = !this.knownFileUris.has(fileUri);
            try {
              const uri = vscode.Uri.file(filePath);
              if (isNewFile) {
                const editPart = new VS.ChatResponseWorkspaceEditPart([
                  { newResource: uri },
                ]);
                stream.push(editPart as unknown as vscode.ChatResponsePart);
                this.log(`pushed WorkspaceEditPart for new file: ${filePath}`);
              } else {
                const editPart = new VS.ChatResponseWorkspaceEditPart([
                  { oldResource: uri, newResource: uri },
                ]);
                stream.push(editPart as unknown as vscode.ChatResponsePart);
                this.log(`pushed WorkspaceEditPart for overwritten file: ${filePath}`);
              }
            } catch {
              // Best-effort; checkpoint still works via externalEdit baseline
            }
          } else if (toolName === 'edit') {
            try {
              const uri = vscode.Uri.file(filePath);
              const editPart = new VS.ChatResponseWorkspaceEditPart([
                { oldResource: uri, newResource: uri },
              ]);
              stream.push(editPart as unknown as vscode.ChatResponsePart);
              this.log(`pushed WorkspaceEditPart for edited file: ${filePath}`);
            } catch {
              // Best-effort
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
      // Cleanup tool metadata for message mode.
      if (this.checkpointMode === 'message' && (toolName === 'edit' || toolName === 'write')) {
        this.log(`message-mode checkpoint: tool ${toolName} completed (callID=${callID}), no signal (already signaled at running)`);
        this.onToolCompleted?.(toolName, callID);
      }

      if (this.checkpointMode === 'permission' && (toolName === 'edit' || toolName === 'write') && this.onCheckpointCycle) {
        await this.onCheckpointCycle();
        this.log(`[bridge] checkpoint signal: mode=permission, at=${toolName}.completed (callID=${callID})`);
      }

      this.toolMetas.delete(callID);
      this.toolCallIds.delete(part.id);
      this.checkpointSignaled.delete(callID);
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
    state: StreamToolState,
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
    this.checkpointSignaled.clear();
    this.assistantPhaseStarted = false;
  }

  private log(message: string): void {
    this.logger?.appendLine(`[streaming] ${message}`);
  }

  private shouldProcessEvent(evt: OpenCodeEvent): boolean {
    if (!this.sessionId) return true;

    switch (evt.type) {
      case 'message.part.updated':
      case 'session.idle': {
        const eventSessionId = getEventSessionId(evt);
        return !eventSessionId || eventSessionId === this.sessionId;
      }
      default:
        return true;
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

function getEventSessionId(evt: OpenCodeEvent): string | undefined {
  switch (evt.type) {
    case 'message.part.updated':
      return evt.properties?.part?.sessionID;
    case 'session.idle':
      return evt.properties?.sessionID;
    case 'permission.asked':
      return evt.properties?.sessionID;
    default:
      return undefined;
  }
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function unwrapStreamEvent(evt: OpenCodeStreamEvent): OpenCodeEvent {
  return 'payload' in evt ? evt.payload : evt;
}

function describeStreamEvent(rawEvt: OpenCodeStreamEvent, evt: OpenCodeEvent): string {
  const base = describeEvent(evt);
  if ('payload' in rawEvt) {
    return `${base} directory=${rawEvt.directory}`;
  }
  return base;
}

function describeEvent(evt: OpenCodeEvent): string {
  switch (evt.type) {
    case 'message.part.updated': {
      const part = evt.properties?.part;
      return part ? `message.part.updated ${describePart(part)}` : 'message.part.updated part=missing';
    }
    case 'message.part.delta':
      return `message.part.delta partID=${evt.properties.partID} len=${evt.properties.delta.length}`;
    case 'session.idle':
      return `session.idle sessionID=${evt.properties.sessionID ?? 'unknown'}`;
    case 'permission.asked': {
      const p = evt.properties;
      return `permission.asked id=${p.id} sessionID=${p.sessionID} permission=${p.permission}`;
    }
    default:
      return evt.type;
  }
}

function describePart(part: MessagePartUpdatedEvent['properties']['part']): string {
  const base = `partType=${part.type} id=${part.id} messageID=${part.messageID ?? 'unknown'}`;
  if (part.type === 'text') {
    const textPart = part as TextStreamPart;
    return `${base} textLen=${textPart.text.length}`;
  }
  if (part.type === 'tool') {
    const toolPart = part as StreamToolPart;
    return `${base} tool=${toolPart.tool} status=${toolPart.state.status}`;
  }
  return base;
}
