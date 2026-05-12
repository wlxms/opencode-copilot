import * as vscode from 'vscode';
import type { ToolCallStatus } from '../types/events';

// =======================================================================
// Proposed API types (chatParticipantAdditions)
// Available at runtime but not in @types/vscode — declared locally.
// Source: microsoft/vscode vscode.proposed.chatParticipantAdditions.d.ts
// =======================================================================

/** Thinking delta for stream.thinkingProgress() */
interface ThinkingDelta {
  text?: string | string[];
  id?: string;
  metadata?: { readonly [key: string]: unknown };
}

/** Streaming data for beginToolInvocation / updateToolInvocation */
interface StreamToolData {
  partialInput?: unknown;
}

// ---------- toolSpecificData variants ----------

/** Terminal/shell command invocation */
interface TerminalToolData {
  commandLine: { original: string; userEdited?: string; toolEdited?: string };
  language: string;
  presentationOverrides?: { commandLine: string; language?: string };
  output?: { text: string };
  state?: { exitCode?: number; duration?: number };
}

/** Collapsible input/output for file reads, list, etc. */
interface SimpleToolResultData {
  input: string;
  output: string;
}

/** File/resource list (collapsible) */
interface ToolResourcesData {
  values: Array<{ path: string; line?: number; character?: number }>;
}

/** Subagent invocation — click to expand subagent details */
interface SubagentToolData {
  description?: string;
  agentName?: string;
  prompt?: string;
  result?: string;
}

/** Union of all tool-specific data types for ChatToolInvocationPart.toolSpecificData */
type ToolSpecificData =
  | TerminalToolData
  | SimpleToolResultData
  | ToolResourcesData
  | SubagentToolData;

// ---------- ChatToolInvocationPart shape ----------

interface ToolInvocationPart {
  toolName: string;
  toolCallId: string;
  isError?: boolean;
  invocationMessage?: string;
  originMessage?: string;
  pastTenseMessage?: string;
  isConfirmed?: boolean;
  isComplete?: boolean;
  toolSpecificData?: ToolSpecificData;
  subAgentInvocationId?: string;
  presentation?: 'hidden' | 'hiddenAfterComplete';
  enablePartialUpdate?: boolean;
  constructor(toolName: string, toolCallId: string, errorMessage?: string): void;
}

/** Extended stream with proposed API methods */
type Stream = vscode.ChatResponseStream & {
  thinkingProgress?(delta: ThinkingDelta): void;
  beginToolInvocation?(callId: string, name: string, data?: StreamToolData): void;
  updateToolInvocation?(callId: string, data: StreamToolData): void;
};

// Runtime access to proposed classes (may not exist)
const VS = vscode as any;

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
 *   read          → SimpleToolResultData (collapsible input/output)
 *   bash          → TerminalToolData (terminal UI with exit code)
 *   write         → ToolResourcesData (file reference list)
 *   list / grep   → SimpleToolResultData (collapsible listing)
 *   task          → SubagentToolData (click to expand subagent)
 *   (other)       → SimpleToolResultData (generic fallback)
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

  /** Get the OpenCode message ID of the user message in this turn, if captured */
  getUserMessageId(): string | null {
    return this.userMessageId;
  }

  async bridgeEventsToStream(
    events: { stream: AsyncIterable<any> },
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<boolean> {
    const s = stream as Stream;
    this.hasThinking = typeof s.thinkingProgress === 'function';
    this.hasToolUI = typeof s.beginToolInvocation === 'function';

    try {
      for await (const evt of events.stream) {
        if (token.isCancellationRequested) break;
        if (this.processEvent(evt, s)) break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection lost';
      stream.markdown(`\n⚠️ ${msg}\n`);
    } finally {
      this.reset();
    }
    return !token.isCancellationRequested;
  }

  // -------------------------------------------------------------------
  // Event dispatch
  // -------------------------------------------------------------------

  private processEvent(evt: any, stream: Stream): boolean {
    switch (evt.type) {
      case 'message.part.updated':
        this.handlePartUpdated(evt, stream);
        return false;
      case 'message.part.delta':
        this.handlePartDelta(evt, stream);
        return false;
      case 'session.idle':
        return true;
    }
    return false;
  }

  // -------------------------------------------------------------------
  // message.part.updated
  // -------------------------------------------------------------------

  private handlePartUpdated(evt: any, stream: Stream): void {
    const part = evt.properties?.part;
    if (!part) return;

    switch (part.type) {
      case 'text': {
        const msgId: string = part.messageID;
        if (!this.userMessageId && part.text && part.text.length > 0) {
          this.userMessageId = msgId;
        }
        if (msgId !== this.userMessageId) {
          this.partKinds.set(part.id, 'text');
        }
        break;
      }
      case 'reasoning': {
        this.partKinds.set(part.id, 'reasoning');
        break;
      }
      case 'tool': {
        this.partKinds.set(part.id, 'tool');
        this.handleToolState(part, stream);
        break;
      }
    }
  }

  // -------------------------------------------------------------------
  // message.part.delta
  // -------------------------------------------------------------------

  private handlePartDelta(evt: any, stream: Stream): void {
    const props = evt.properties;
    if (!props?.delta) return;

    const partID: string = props.partID;
    const delta: string = props.delta;
    const kind = this.partKinds.get(partID);

    if (kind === 'reasoning') {
      if (this.hasThinking && stream.thinkingProgress) {
        stream.thinkingProgress({ text: delta, id: partID });
      }
    } else if (kind === 'text') {
      stream.markdown(delta);
    }
  }

  // -------------------------------------------------------------------
  // Tool call state machine: pending → running → completed
  // -------------------------------------------------------------------

  private handleToolState(part: any, stream: Stream): void {
    const state = part.state;
    if (!state) return;

    const toolName: string = part.tool ?? 'unknown';
    const callID: string = part.callID ?? part.id;
    const status: ToolCallStatus = state.status;

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
      return;
    }

    if (status === 'running') {
      // --- TOOL RUNNING (has input) ---
      const meta = this.toolMetas.get(callID);
      if (meta) {
        meta.input = state.input ?? {};
        meta.title = state.title;
        meta.timeStart = state.time?.start;
      }
      if (this.hasToolUI && stream.updateToolInvocation) {
        stream.updateToolInvocation(callID, {
          partialInput: state.input ?? {},
        });
      }
      return;
    }

    if (status === 'completed') {
      // --- TOOL COMPLETED ---
      const meta = this.toolMetas.get(callID);
      if (meta) {
        meta.output = state.output ?? '';
        meta.timeEnd = state.time?.end;
        meta.title = state.title ?? meta.title;
      }

      // Build and push ChatToolInvocationPart
      if (this.hasToolUI && VS.ChatToolInvocationPart) {
        this.pushToolInvocation(stream, callID, toolName, state);
      } else {
        this.renderToolFallback(
          stream, toolName, state.input, state.output, state.title,
        );
      }
      this.toolMetas.delete(callID);
      this.toolCallIds.delete(part.id);
    }
  }

  // -------------------------------------------------------------------
  // Push ChatToolInvocationPart with appropriate toolSpecificData
  // -------------------------------------------------------------------

  private pushToolInvocation(
    stream: Stream,
    callID: string,
    toolName: string,
    state: ToolState,
  ): void {
    try {
      const meta = this.toolMetas.get(callID);
      const title = state.title ?? meta?.title ?? toolName;
      const input = state.input ?? meta?.input ?? {};
      const output: string = state.output ?? meta?.output ?? '';
      const timeStart = state.time?.start ?? meta?.timeStart;
      const timeEnd = state.time?.end ?? meta?.timeEnd;

      const part: ToolInvocationPart = new VS.ChatToolInvocationPart(
        toolName,
        callID,
      );
      part.enablePartialUpdate = true;
      part.isComplete = true;
      part.invocationMessage = this.formatInvocationMsg(toolName, input, title);
      part.pastTenseMessage = this.formatPastTenseMsg(toolName, title, timeStart, timeEnd);

      // Select and attach the appropriate toolSpecificData
      part.toolSpecificData = this.buildToolSpecificData(
        toolName, title, input, output, timeStart, timeEnd,
      );

      stream.push(part);
    } catch {
      this.renderToolFallback(stream, toolName, state.input, state.output, state.title);
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
  ): ToolSpecificData | undefined {
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
        } satisfies TerminalToolData;
      }

      case 'read':
      case 'list':
      case 'grep': {
        return {
          input: formatInput(input, title),
          output: truncate(output, 2000),
        } satisfies SimpleToolResultData;
      }

      case 'write':
      case 'edit': {
        // Show as file reference if filePath is available
        const filePath = input.filePath as string | undefined;
        if (filePath) {
          return {
            values: [{ path: filePath }],
          } satisfies ToolResourcesData;
        }
        return {
          input: formatInput(input, title),
          output: truncate(output, 2000),
        } satisfies SimpleToolResultData;
      }

      case 'task':
      case 'subagent': {
        return {
          description: (input.description as string) ?? title,
          agentName: (input.agentName as string) ?? toolName,
          prompt: (input.prompt as string) ?? formatInput(input, ''),
          result: truncate(output, 4000),
        } satisfies SubagentToolData;
      }

      default:
        // Generic fallback
        if (Object.keys(input).length > 0 || output) {
          return {
            input: formatInput(input, title),
            output: truncate(output, 2000),
          } satisfies SimpleToolResultData;
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
  }
}

// =======================================================================
// Helpers
// =======================================================================

type PartKind = 'reasoning' | 'text' | 'tool';

interface ToolMeta {
  name: string;
  input: Record<string, unknown> | undefined;
  output: string | undefined;
  title: string | undefined;
  timeStart: number | undefined;
  timeEnd: number | undefined;
}

interface ToolState {
  input?: Record<string, unknown>;
  output?: string;
  title?: string;
  time?: { start?: number; end?: number };
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
