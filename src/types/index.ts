import * as vscode from 'vscode';
import type {
  ConfigProvidersResponse,
  SessionCreateResponse,
  SessionGetResponse,
  SessionPromptResponse,
  SessionRevertResponse,
} from '@opencode-ai/sdk';
import type { OpenCodeEventStream } from '../backends/opencode/sdk-events';
import type { AcpBackend } from '../acp/backend';

export interface OpenCodeApiResponse<T, E = unknown> {
  data?: T;
  error?: E;
}

export interface OpenCodeClient {
  session: {
    create(options?: {
      body?: { parentID?: string; title?: string };
      query?: { directory?: string };
    }): Promise<OpenCodeApiResponse<SessionCreateResponse>>;
    get(options: {
      path: { id: string };
      query?: { directory?: string };
    }): Promise<OpenCodeApiResponse<SessionGetResponse>>;
    prompt(options: {
      path: { id: string };
      body: { parts: Array<{ type: 'text'; text: string }> };
      query?: { directory?: string };
    }): Promise<OpenCodeApiResponse<SessionPromptResponse>>;
    revert(options: {
      path: { id: string };
      body: { messageID: string; partID?: string };
      query?: { directory?: string };
    }): Promise<OpenCodeApiResponse<SessionRevertResponse>>;
    abort(options: {
      path: { id: string };
      query?: { directory?: string };
    }): Promise<OpenCodeApiResponse<boolean>>;
  };
  global: {
    event(): Promise<OpenCodeEventStream>;
  };
  event: {
    subscribe(): Promise<OpenCodeEventStream>;
  };
  config: {
    providers(): Promise<OpenCodeApiResponse<ConfigProvidersResponse>>;
  };
  /** Reply to a permission.asked request — approves or rejects the paused tool */
  postSessionIdPermissionsPermissionId(options: {
    path: { id: string; permissionID: string };
    body?: { response: 'once' | 'always' | 'reject' };
    query?: { directory?: string };
  }): Promise<unknown>;
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
}
