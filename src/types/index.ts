import type * as vscode from 'vscode';
import type { OpenCodeEventStream } from '../backends/opencode/sdk-events';
import type { AcpBackend } from '../acp/backend';
import type { StatusBarManager } from '../statusbar';
import type { AcpModelSelection } from '../acp/types';

export interface OpenCodeApiResponse<T, E = unknown> {
  data?: T;
  error?: E;
}

export interface OpenCodeClient {
  session: {
    create(parameters?: {
      directory?: string;
      parentID?: string;
      title?: string;
    }): Promise<unknown>;
    get(parameters: {
      sessionID: string;
      directory?: string;
    }): Promise<unknown>;
    prompt(parameters: {
      sessionID: string;
      directory?: string;
      parts?: Array<{ type: 'text'; text: string }>;
      model?: { providerID: string; modelID: string };
      agent?: string;
    }): Promise<unknown>;
    revert(parameters: {
      sessionID: string;
      directory?: string;
      messageID: string;
      partID?: string;
    }): Promise<unknown>;
    abort(parameters: {
      sessionID: string;
      directory?: string;
    }): Promise<unknown>;
    list(parameters?: {
      directory?: string;
    }): Promise<unknown>;
    children(parameters: {
      sessionID: string;
      directory?: string;
    }): Promise<unknown>;
    status(parameters?: {
      directory?: string;
    }): Promise<unknown>;
  };
  global: {
    event(): Promise<unknown>;
  };
  event: {
    subscribe(): Promise<unknown>;
  };
  config: {
    providers(parameters?: {
      directory?: string;
    }): Promise<unknown>;
  };
  permission: {
    reply(parameters: {
      requestID: string;
      directory?: string;
      reply?: 'once' | 'always' | 'reject';
      message?: string;
    }): Promise<unknown>;
  };
  question: {
    reply(parameters: {
      requestID: string;
      directory?: string;
      answers?: Array<Array<string>>;
    }): Promise<unknown>;
    reject(parameters: {
      requestID: string;
      directory?: string;
    }): Promise<unknown>;
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
  /** Current agent selection for next prompt */
  currentAgent?: string;
  /** Current model selection for next prompt */
  currentModel?: AcpModelSelection;
  /** Current model display name for status bar / UI */
  currentModelDisplayName?: string;
  /** Explicit agent override chosen by user for prompt calls */
  selectedAgentOverride?: string;
  /** Explicit model override chosen by user for prompt calls */
  selectedModelOverride?: AcpModelSelection;
}
