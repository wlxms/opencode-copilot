import type * as vscode from 'vscode';
import type { AcpBackend } from '../acp/backend';
import type { StatusBarManager } from '../statusbar';

// ===========================================================================
// Re-export SDK types from their new location for backward compatibility
// during migration. TODO: remove these re-exports once all consumers
// import directly from backends/opencode/sdk-types.
// ===========================================================================

export type {
  SdkResponse,
  SdkSessionData,
  SdkProviderModel,
  SdkProvider,
  SdkAgentData,
  SdkConfigData,
  SdkUserMessage,
  SdkAssistantMessage,
  SdkMessage,
  SdkTextPart,
  SdkReasoningPart,
  SdkToolPart,
  SdkSubtaskPart,
  SdkPart,
  OpenCodeClient,
  OpenCodeServerController,
} from '../backends/opencode/sdk-types';

/** Info about a conversation session extracted from SDK response */
export interface SessionInfo {
  id: string;
  title: string;
  createdAt: Date;
}

/** Tracks the mapping between VSCode chat turns and backend message IDs */
export interface TurnMapping {
  /** 0-based index of the VSCode user turn */
  vscodeTurn: number;
  /** Corresponding backend message ID */
  messageId: string;
}

/** Per-VSCode-chat session state (one per VSCode chat panel) */
export interface SessionState {
  sessionId: string;
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
  /** ACPModels bidirectional model registry (Copilot ↔ ACP backends) */
  acpModels: import('../acpmodels/index').AcpModels;
  /** Output channel for logging */
  outputChannel: vscode.OutputChannel;
  /** Status bar controller (shows backend / agent / model) */
  statusBar: StatusBarManager;
  /** Centralised agent/model selection state */
  selection: import('../acp/selection-store').SelectionStore;
  /** Centralised session mapping (VSCode chat → backend session) */
  sessions: import('../acp/session-manager').SessionManager;
  /** Filesystem-backed persistent session store */
  sessionStore: import('../acp/streaming/session-store').SessionStore;
  /** Application-level typed event bus */
  bus: import('../acp/app-event-bus').AppEventBus;
}
