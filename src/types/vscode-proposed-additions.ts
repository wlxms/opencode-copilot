/**
 * Proposed API types from vscode.proposed.chatParticipantAdditions.d.ts (version 3)
 *
 * Source: https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.chatParticipantAdditions.d.ts
 *
 * These types are NOT yet in @types/vscode. They are available at runtime
 * ONLY when `chatParticipantAdditions` is enabled in package.json's `enabledApiProposals`.
 *
 * Declared here locally for compile-time type safety. When VSCode stabilizes
 * these APIs and they land in @types/vscode, switch to importing from 'vscode' directly.
 *
 * NOTE: Do NOT augment the 'vscode' module here — that is done in the separate
 * file vscode-proposed.d.ts for chatParticipantPrivate. This file exports
 * standalone types for direct import.
 */

import type {
  Location,
  MarkdownString,
  Uri,
} from 'vscode';

// ---------------------------------------------------------------------------
// Tool streaming data
// ---------------------------------------------------------------------------

/**
 * Streaming data for beginToolInvocation / updateToolInvocation.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts v3
 */
export interface ChatToolInvocationStreamData {
  readonly partialInput?: unknown;
}

// ---------------------------------------------------------------------------
// toolSpecificData types
// ---------------------------------------------------------------------------

/**
 * Terminal/shell command invocation data.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts v3
 */
export interface ChatTerminalToolInvocationData {
  commandLine: {
    original: string;
    userEdited?: string;
    toolEdited?: string;
  };
  language: string;
  presentationOverrides?: {
    commandLine: string;
    language?: string;
  };
  output?: { text: string };
  state?: { exitCode?: number; duration?: number };
}

/**
 * Simple collapsible input/output result data.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts v3
 */
export interface ChatSimpleToolResultData {
  input: string;
  output: string;
}

/**
 * File/resource list invocation data — renders as a collapsible list.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts v3
 */
export interface ChatToolResourcesInvocationData {
  values: Array<Uri | Location>;
}

/**
 * Subagent invocation data — click to expand subagent details.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts v3
 */
export class ChatSubagentToolInvocationData {
  description?: string;
  agentName?: string;
  prompt?: string;
  result?: string;

  constructor(
    description?: string,
    agentName?: string,
    prompt?: string,
    result?: string,
  ) {
    this.description = description;
    this.agentName = agentName;
    this.prompt = prompt;
    this.result = result;
  }
}

/**
 * MCP (Model Context Protocol) tool invocation data.
 * Placeholder — exact interface TBD from VSCode API.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts v3
 */
export interface ChatMcpToolInvocationData {
  /** MCP server name */
  name?: string;
  /** JSON arguments for the MCP tool call */
  input?: unknown;
  /** Text output from the MCP tool */
  output?: string;
}

/**
 * Todo tool invocation data.
 * Placeholder — exact interface TBD from VSCode API.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts v3
 */
export interface ChatTodoToolInvocationData {
  [key: string]: unknown;
}

/**
 * Union of all tool-specific data types accepted by ChatToolInvocationPart.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts v3
 */
export type ChatToolSpecificData =
  | ChatTerminalToolInvocationData
  | ChatMcpToolInvocationData
  | ChatTodoToolInvocationData
  | ChatSimpleToolResultData
  | ChatToolResourcesInvocationData
  | ChatSubagentToolInvocationData;

// ---------------------------------------------------------------------------
// ChatToolInvocationPart
// ---------------------------------------------------------------------------

/**
 * A chat response part that renders a tool invocation with rich UI.
 *
 * Properties:
 * - toolName / toolCallId — identifies the tool
 * - invocationMessage — shown while tool is running (e.g., "Running grep...")
 * - pastTenseMessage — shown after completion (e.g., "Searched in 0.3s")
 * - isError — if true, renders with error styling
 * - toolSpecificData — drives the expandable card UI per tool type
 * - presentation — controls visibility ('hidden' hides it entirely)
 * - subAgentInvocationId — links to a sub-agent's session
 * - enablePartialUpdate — enables progressive push (isComplete=false → true)
 *
 * Source: vscode.proposed.chatParticipantAdditions.d.ts v3
 */
export class ChatToolInvocationPart {
  toolName: string;
  toolCallId: string;
  isError?: boolean;
  invocationMessage?: string | MarkdownString;
  originMessage?: string | MarkdownString;
  pastTenseMessage?: string | MarkdownString;
  isConfirmed?: boolean;
  isComplete?: boolean;
  toolSpecificData?: ChatToolSpecificData;
  subAgentInvocationId?: string;
  presentation?: 'hidden' | 'hiddenAfterComplete' | undefined;
  enablePartialUpdate?: boolean;

  constructor(
    toolName: string,
    toolCallId: string,
    errorMessage?: string,
  ) {
    this.toolName = toolName;
    this.toolCallId = toolCallId;
    this.isError = !!errorMessage;
  }
}

// ---------------------------------------------------------------------------
// ExtendedChatResponseParts — lists all proposed chat response parts
// ---------------------------------------------------------------------------

/**
 * Internal type that lists all the proposed chat response parts.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts v3
 */
export interface ExtendedChatResponseParts {
  ChatResponsePart: unknown;
  ChatResponseTextEditPart: unknown;
  ChatResponseNotebookEditPart: unknown;
  ChatResponseWorkspaceEditPart: unknown;
  ChatResponseConfirmationPart: unknown;
  ChatResponseCodeCitationPart: unknown;
  ChatResponseReferencePart2: unknown;
  ChatResponseMovePart: unknown;
  ChatResponseExtensionsPart: unknown;
  ChatResponsePullRequestPart: unknown;
  ChatToolInvocationPart: ChatToolInvocationPart;
  ChatResponseMultiDiffPart: unknown;
  ChatResponseThinkingProgressPart: unknown;
  ChatResponseExternalEditPart: unknown;
  ChatResponseQuestionCarouselPart: unknown;
}

/**
 * The actual type used for extended chat response parts.
 * Source: vscode.proposed.chatParticipantAdditions.d.ts v3
 */
export type ExtendedChatResponsePart = ExtendedChatResponseParts[keyof ExtendedChatResponseParts];
