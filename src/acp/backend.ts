/**
 * ACP (Agent Communication Protocol) backend interface.
 *
 * Defines the contract that every backend adapter must fulfil.
 * The participant layer consumes this - never the raw SDK or VSCode APIs.
 */

import type { CancellationToken } from 'vscode';

import type {
  AcpChildSessionInfo,
  AcpSessionInfo,
  AcpSessionStatus,
  AcpAgent,
  AcpConfig,
  AcpFileAttachment,
  AcpResult,
  AcpModel,
  AcpPermissionResponse,
  AcpServerInfo,
  AcpServerStatus,
  AcpMessageHistory,
  BackendSettingsDescriptor,
} from './types';

import type { FileSnapshotRecord, SessionTitleSource } from '../acp/serializable/types';

// ===========================================================================
// Event stream
// ===========================================================================

export interface AcpEventStream<TEvent = unknown> {
  stream: AsyncIterable<TEvent>;
}

// ===========================================================================
// Session operations
// ===========================================================================

export interface AcpSessionOperations {
  create(options?: {
    parentId?: string;
    title?: string;
    directory?: string;
  }): Promise<AcpResult<AcpSessionInfo>>;

  get(
    id: string,
    directory?: string,
  ): Promise<AcpResult<AcpSessionInfo>>;

  update(
    id: string,
    options: { title?: string; directory?: string },
  ): Promise<AcpResult<AcpSessionInfo>>;

  prompt(
    id: string,
    text: string,
    directory?: string,
    options?: {
      model?: { providerID: string; modelID: string };
      agent?: string;
      /** File attachments (images, documents) to include with the prompt */
      attachments?: AcpFileAttachment[];
    },
  ): Promise<AcpResult<unknown>>;

  revert(
    id: string,
    messageId: string,
    partId?: string,
    directory?: string,
  ): Promise<AcpResult<unknown>>;

  abort(
    id: string,
    directory?: string,
  ): Promise<AcpResult<boolean>>;

  list(directory?: string): Promise<AcpResult<AcpSessionInfo[]>>;

  /** Get child sessions of a given parent session */
  children(id: string, directory?: string): Promise<AcpResult<AcpChildSessionInfo[]>>;

  /** Get status of all sessions: { [sessionId]: SessionStatus } */
  status(directory?: string): Promise<AcpResult<Record<string, AcpSessionStatus>>>;

  // -- Hierarchy navigation (sub-agent session tree) ---------------------

  /** Get all descendant session IDs (children, grandchildren, etc.) */
  descendants(parentId: string): string[];

  /** Walk up the parent chain and return the first session ID found in `candidateIds` */
  findAncestor(sessionId: string, candidateIds: Set<string>): string | undefined;

  /** Get the parent session ID for a given session */
  parent(sessionId: string): string | undefined;

  /**
   * Get message history for a session.
   * Returns user/assistant message pairs with text content extracted from parts.
   */
  messages(id: string, directory?: string): Promise<AcpResult<AcpMessageHistory>>;
}

// ===========================================================================
// Config operations
// ===========================================================================

export interface AcpConfigOperations {
  models(directory?: string): Promise<AcpResult<AcpModel[]>>;

  /** List available agents */
  agents(directory?: string): Promise<AcpResult<AcpAgent[]>>;

  /** Get full configuration */
  get(directory?: string): Promise<AcpResult<AcpConfig>>;

  /** Update configuration (partial merge) */
  update(config: Partial<AcpConfig>, directory?: string): Promise<AcpResult<void>>;

  /** Update global configuration (persists to disk, no restart needed) */
  updateGlobal(config: Partial<AcpConfig>): Promise<AcpResult<void>>;
}

// ===========================================================================
// Event operations
// ===========================================================================

export interface AcpEventOperations<TEvent = unknown> {
  /** Open a per-session event stream */
  openSessionStream(sessionId: string): AcpEventStream<TEvent>;

  /** Open the global event stream (all sessions) */
  openGlobalStream(): Promise<AcpEventStream<TEvent>>;

  /** Close a previously-opened session stream */
  closeSessionStream(sessionId: string): void;

  /** Ensure global event subscription is active for the given client */
  ensureStarted(): Promise<void>;
}

// ===========================================================================
// Permission operations
// ===========================================================================

export interface AcpPermissionOperations {
  reply(
    sessionId: string,
    permissionId: string,
    response: AcpPermissionResponse,
    directory?: string,
  ): Promise<void>;
}

// ===========================================================================
// Question operations
// ===========================================================================

export interface AcpQuestionOperations {
  /** Reply to a question.asked request with user answers */
  reply(
    sessionId: string,
    requestId: string,
    answers: Array<Array<string>>,
    directory?: string,
  ): Promise<AcpResult<boolean>>;

  /** Reject a question.asked request */
  reject(
    sessionId: string,
    requestId: string,
    directory?: string,
  ): Promise<AcpResult<boolean>>;
}

// ===========================================================================
// Backend settings provider (pluggable settings UI)
// ===========================================================================

export interface BackendSettingsProvider {
  /** Build the settings descriptor for the current backend state */
  getDescriptor(agents: AcpAgent[], models: AcpModel[]): Promise<BackendSettingsDescriptor>;
  /** Persist backend-specific settings values */
  saveValues(values: Record<string, unknown>): Promise<void>;
}

// ===========================================================================
// Auth operations
// ===========================================================================

/** Auth key operations shared across all ACP backends */
export interface AcpAuthOperations {
  /** Persist an API key for a provider (writes to backend auth storage) */
  setKey(providerID: string, key: string): Promise<AcpResult<void>>;
  /** Remove an API key for a provider */
  removeKey(providerID: string): Promise<AcpResult<void>>;
}

// ===========================================================================
// AcpBridge - backend-specific event interpreter
// ===========================================================================

/** A bridge that interprets backend stream events and translates them to
 *  push/update calls on the SerializableSessionStream (SSS).
 *
 *  The bridge does NOT touch the VS Code stream directly; SSS owns it.
 *  The bridge only calls sss.push(ssp) / sss.update(id, data).
 *
 *  Each backend provides its own implementation via {@link AcpBackend.createBridge}. */
export interface AcpBridge<TEvent = unknown> {
  /** Inject the SerializableSessionStream (which owns the VS Code stream) */
  setSSS(sss: unknown): void;
  /** Run the full event loop and translate events to push/update calls */
  run(events: AsyncIterable<TEvent>, token: CancellationToken): Promise<boolean>;
  /** Get the captured user message ID, or null if no text part was seen */
  getUserMessageId(): string | null;
  /** Get the backend-generated session title, or null */
  getSessionTitle(): string | null;
  /** Get the source of the captured session title, or null */
  getSessionTitleSource?(): SessionTitleSource | null;
  /** Whether at least one subagent (task) tool completed during this session */
  getHadSubagentTasks(): boolean;
}

// ===========================================================================
// Complete backend contract
// ===========================================================================

export interface AcpBackend<TEvent = unknown> {
  /** Human-readable backend name */
  readonly name: string;

  // -- lifecycle -------------------------------------------------------

  start(directory?: string): Promise<AcpResult<AcpServerInfo>>;
  stop(): Promise<void>;
  getStatus(): AcpServerStatus;
  getUrl(): string | null;
  isRunning(): boolean;

  // -- sub-operations --------------------------------------------------

  sessions: AcpSessionOperations;
  config: AcpConfigOperations;
  events: AcpEventOperations<TEvent>;
  permissions: AcpPermissionOperations;
  questions: AcpQuestionOperations;

  /** Create a streaming bridge for interpreting events from this backend.
   *  The bridge handles both live rendering and session restore (replay).
   *  @param sessionId - the session to bridge events for
   *  @param directory - optional workspace directory */
  createBridge(sessionId: string, directory?: string): AcpBridge<TEvent>;

  auth: AcpAuthOperations;

  // -- pluggable settings UI -------------------------------------------

  /** Optional: provides backend-specific settings descriptor for the UI */
  readonly settingsProvider?: BackendSettingsProvider;
}
