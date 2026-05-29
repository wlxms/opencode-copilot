import type * as vscode from 'vscode';
import type { OpenCodeEventStream } from '../backends/opencode/sdk-events';
import type { AcpBackend } from '../acp/backend';
import type { StatusBarManager } from '../statusbar';
import type { AcpModelSelection, AcpSessionStatus } from '../acp/types';

// ===========================================================================
// SDK response wrapper — mirrors the hey-api RequestResult flat shape
// ===========================================================================

export interface SdkResponse<T> {
  data?: T;
  error?: unknown;
}

// ===========================================================================
// Shared response data shapes (extracted from SDK v2 response union types)
// ===========================================================================

export interface SdkSessionData {
  id?: string;
  title?: string;
  time?: { created?: number };
}

export interface SdkProviderModel {
  id: string;
  name?: string;
  providerID?: string;
  capabilities?: Record<string, unknown>;
}

export interface SdkProvider {
  id: string;
  name: string;
  models?: Record<string, SdkProviderModel>;
}

export interface SdkAgentData {
  id?: string;
  name?: string;
  description?: string;
  model?: string | { modelID: string; providerID: string };
  mode?: string;
  hidden?: boolean;
}

export interface SdkConfigData {
  model?: string;
  small_model?: string;
  default_agent?: string;
  disabled_providers?: string[];
  enabled_providers?: string[];
  agent?: Record<string, unknown>;
  provider?: Record<string, unknown>;
}

// ===========================================================================
// SDK message / part shapes (from session.messages() response)
// ===========================================================================

export interface SdkUserMessage {
  id: string;
  sessionID: string;
  role: 'user';
  time: { created: number };
  agent: string;
  model: { providerID: string; modelID: string };
}

export interface SdkAssistantMessage {
  id: string;
  sessionID: string;
  role: 'assistant';
  time: { created: number; completed?: number };
  parentID: string;
  modelID: string;
  providerID: string;
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  error?: { name: string; data?: { message?: string } };
}

export type SdkMessage = SdkUserMessage | SdkAssistantMessage;

export interface SdkTextPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'text';
  text: string;
  synthetic?: boolean;
}

export interface SdkReasoningPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'reasoning';
  text: string;
}

export interface SdkToolPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'tool';
  tool: string;
  callID?: string;
  state?: { status: string; input?: Record<string, unknown>; output?: string; title?: string; error?: string };
}

export interface SdkSubtaskPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'subtask';
  prompt: string;
  description: string;
  agent: string;
}

export type SdkPart = SdkTextPart | SdkReasoningPart | SdkToolPart | SdkSubtaskPart | {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  [key: string]: unknown;
};

// ===========================================================================
// OpenCodeClient — typed contract for the OpenCode SDK v2 client
//
// This interface describes the subset of the SDK v2 OpencodeClient API
// that our codebase actually consumes. The adapter layer bridges between
// this contract and the raw SDK at the architectural boundary (server.ts).
// ===========================================================================

export interface OpenCodeClient {
  session: {
    create(parameters?: {
      directory?: string;
      parentID?: string;
      title?: string;
      agent?: string;
      model?: unknown;
    }): Promise<SdkResponse<SdkSessionData>>;
    get(parameters: {
      sessionID: string;
      directory?: string;
    }): Promise<SdkResponse<SdkSessionData>>;
    update(parameters: {
      sessionID: string;
      directory?: string;
      title?: string;
    }): Promise<SdkResponse<SdkSessionData>>;
    prompt(parameters: {
      sessionID: string;
      directory?: string;
      parts?: unknown;
      model?: unknown;
      agent?: string;
    }): Promise<SdkResponse<unknown>>;
    revert(parameters: {
      sessionID: string;
      directory?: string;
      messageID: string;
      partID?: string;
    }): Promise<SdkResponse<unknown>>;
    abort(parameters: {
      sessionID: string;
      directory?: string;
    }): Promise<SdkResponse<boolean>>;
    list(parameters?: {
      directory?: string;
    }): Promise<SdkResponse<SdkSessionData[]>>;
    children(parameters: {
      sessionID: string;
      directory?: string;
    }): Promise<SdkResponse<Array<{ id?: string; parentID?: string }>>>;
    status(parameters?: {
      directory?: string;
    }): Promise<SdkResponse<Record<string, AcpSessionStatus>>>;
    messages(parameters: {
      id: string;
      directory?: string;
      limit?: number;
    }): Promise<SdkResponse<Array<{ info: SdkMessage; parts: SdkPart[] }>>>;
  };
  global: {
    event(): Promise<OpenCodeEventStream>;
  };
  event: {
    subscribe(): Promise<OpenCodeEventStream>;
  };
  app: {
    agents(parameters?: {
      directory?: string;
    }): Promise<SdkResponse<SdkAgentData[]>>;
  };
  config: {
    providers(parameters?: {
      directory?: string;
    }): Promise<SdkResponse<{ providers?: SdkProvider[] }>>;
    get(parameters?: {
      directory?: string;
    }): Promise<SdkResponse<SdkConfigData>>;
    update(parameters?: {
      directory?: string;
      config?: unknown;
    }): Promise<SdkResponse<unknown>>;
  };
  permission: {
    reply(parameters: {
      requestID: string;
      directory?: string;
      reply?: 'once' | 'always' | 'reject';
      message?: string;
    }): Promise<SdkResponse<unknown>>;
  };
  question: {
    reply(parameters: {
      requestID: string;
      directory?: string;
      answers?: Array<Array<string>>;
    }): Promise<SdkResponse<boolean>>;
    reject(parameters: {
      requestID: string;
      directory?: string;
    }): Promise<SdkResponse<boolean>>;
  };
}

export interface OpenCodeServerController {
  start(cwd?: string): Promise<string>;
  stop(): Promise<void>;
  getClient(): OpenCodeClient | null;
  getStatus(): 'stopped' | 'starting' | 'running' | 'error';
  isRunning(): boolean;
  getUrl(): string | null;
}

/** Info about a conversation session extracted from SDK response */
export interface SessionInfo {
  id: string;
  title: string;
  createdAt: Date;
}

/** Tracks the mapping between VSCode chat turns and OpenCode message IDs */
export interface TurnMapping {
  /** 0-based index of the VSCode user turn */
  vscodeTurn: number;
  /** Corresponding OpenCode message ID */
  opencodeMessageId: string;
}

/** Per-VSCode-chat session state (one per VSCode chat panel) */
export interface SessionState {
  opencodeSessionId: string;
  turnMap: TurnMapping[];
  title?: string;
  createdAt?: Date;
}

// ===========================================================================
// Persisted settings state (stored in VS Code globalState)
// ===========================================================================

/** Shape of settings state persisted in VS Code globalState (survives extension reloads) */
export interface PersistedSettingsState {
  /** Persisted agent selection (undefined = use backend default) */
  currentAgent?: string;
  /** Persisted model selection (undefined = use backend default or agent default) */
  currentModel?: { providerID: string; modelID: string };
  /** Persisted model display name for status bar / UI */
  currentModelDisplayName?: string;
}

/** Global extension state shared across modules */
export interface ExtensionState {
  /** ACP-compatible backend abstraction used by all surfaces */
  backend: AcpBackend;
  /** Output channel for logging */
  outputChannel: vscode.OutputChannel;
  /**
   * Maps VSCode chat sessionId → session state (OpenCode ID + per-session turnMap).
   * Same VSCode chat panel = same sessionId → reuse OpenCode session.
   * New VSCode chat = new sessionId → create new OpenCode session.
   * Each chat has its own turnMap, so switching chats doesn't lose rewind context.
   */
  sessionMap: Map<string, SessionState>;
  /** Status bar controller (shows backend / agent / model) */
  statusBar: StatusBarManager;
  /** Current agent selection — the single source of truth. Written by ANY UI (settings panel, session target picker). Read by ALL handlers. */
  currentAgent?: string;
  /** Current model selection — the single source of truth. Written by ANY UI, read by ALL handlers. */
  currentModel?: AcpModelSelection;
  /** Current model display name for status bar / UI */
  currentModelDisplayName?: string;
  /** Refresh published chat session items, if the session provider is active. */
  refreshSessionItems?: () => Promise<void>;
  /**
   * Called once when the backend transitions from not-running to running.
   * Used by the session provider to trigger its first real data fetch
   * without polling while the backend is offline.
   */
  onBackendReady?: () => void;
}
