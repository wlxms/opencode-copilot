import * as vscode from 'vscode';

/** Info about a conversation session extracted from SDK response */
export interface SessionInfo {
  id: string;
  title: string;
  createdAt: Date;
}

/** Global extension state shared across modules */
export interface ExtensionState {
  /** The OpenCode server manager instance */
  serverManager: any;
  /** SDK OpencodeClient from createOpencode() (null until started) */
  client: any | null;
  /** Currently active session ID */
  activeSessionId: string | null;
  /** Server status */
  serverStatus: 'stopped' | 'starting' | 'running' | 'error';
  /** Output channel for logging */
  outputChannel: vscode.OutputChannel;
}
