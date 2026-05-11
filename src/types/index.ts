import * as vscode from 'vscode';

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
  serverManager: any;
  /** SDK OpencodeClient from createOpencode() (null until started) */
  client: any | null;
  /** Currently active session ID (convenience, for the most recent session) */
  activeSessionId: string | null;
  /** Server status */
  serverStatus: 'stopped' | 'starting' | 'running' | 'error';
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
