import * as vscode from 'vscode';
import type {
  ConfigProvidersResponse,
  SessionCreateResponse,
  SessionGetResponse,
  SessionPromptResponse,
  SessionRevertResponse,
} from '@opencode-ai/sdk';
import type { OpenCodeEventStream } from './events';
import type { GlobalEventBroker } from '../participant/event-broker';
import type { CheckpointMode } from '../config';

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
    subscribe(options?: {
      query?: { directory?: string };
    }): Promise<OpenCodeEventStream>;
  };
  config: {
    providers(): Promise<OpenCodeApiResponse<ConfigProvidersResponse>>;
    update(options: {
      body?: {
        permission?: {
          edit?: 'ask' | 'allow' | 'deny';
          bash?: ('ask' | 'allow' | 'deny') | Record<string, 'ask' | 'allow' | 'deny'>;
          webfetch?: 'ask' | 'allow' | 'deny';
          doom_loop?: 'ask' | 'allow' | 'deny';
          external_directory?: 'ask' | 'allow' | 'deny';
        };
        [key: string]: unknown;
      };
      query?: { directory?: string };
    }): Promise<OpenCodeApiResponse<unknown>>;
  };
  /**
   * Approve or reject a pending permission request.
   * Maps to POST /session/{id}/permissions/{permissionID}.
   */
  postSessionIdPermissionsPermissionId(options: {
    body?: { response: 'once' | 'always' | 'reject' };
    path: { id: string; permissionID: string };
    query?: { directory?: string };
  }): Promise<OpenCodeApiResponse<boolean>>;
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
    subscribe(options?: {
      query?: { directory?: string };
    }): Promise<OpenCodeEventStream>;
  };
  config: {
    providers(): Promise<OpenCodeApiResponse<ConfigProvidersResponse>>;
    update(options: {
      body?: {
        permission?: {
          edit?: 'ask' | 'allow' | 'deny';
          bash?: ('ask' | 'allow' | 'deny') | Record<string, 'ask' | 'allow' | 'deny'>;
          webfetch?: 'ask' | 'allow' | 'deny';
          doom_loop?: 'ask' | 'allow' | 'deny';
          external_directory?: 'ask' | 'allow' | 'deny';
        };
        [key: string]: unknown;
      };
      query?: { directory?: string };
    }): Promise<OpenCodeApiResponse<unknown>>;
  };
  /** Respond to a pending permission request (auto-approve in Copilot). */
  postSessionIdPermissionsPermissionId(options: {
    body?: { response: 'once' | 'always' | 'reject' };
    path: { id: string; permissionID: string };
    query?: { directory?: string };
  }): Promise<OpenCodeApiResponse<boolean>>;
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
  /** The OpenCode server manager instance */
  serverManager: OpenCodeServerController;
  /** SDK OpencodeClient from createOpencode() (null until started) */
  client: OpenCodeClient | null;
  /** Currently active session ID (convenience, for the most recent session) */
  activeSessionId: string | null;
  /** Server status */
  serverStatus: 'stopped' | 'starting' | 'running' | 'error';
  /** Output channel for logging */
  outputChannel: vscode.OutputChannel;
  /** Shared global SSE broker for multiplexing OpenCode session events */
  eventBroker: GlobalEventBroker;
  /**
   * Maps VSCode chat sessionId → session state (OpenCode ID + per-session turnMap).
   * Same VSCode chat panel = same sessionId → reuse OpenCode session.
   * New VSCode chat = new sessionId → create new OpenCode session.
   * Each chat has its own turnMap, so switching chats doesn't lose rewind context.
   */
  sessionMap: Map<string, SessionState>;
}
