/**
 * ACP (Agent Communication Protocol) backend interface.
 *
 * Defines the contract that every backend adapter must fulfil.
 * The participant layer consumes this — never the raw SDK or VSCode APIs.
 */

import type {
  AcpChildSessionInfo,
  AcpSessionInfo,
  AcpSessionStatus,
  AcpAgent,
  AcpConfig,
  AcpFileAttachment,
  AcpResult,
  AcpEvent,
  AcpModel,
  AcpPermissionResponse,
  AcpServerInfo,
  AcpServerStatus,
  AcpMessageHistory,
  BackendSettingsDescriptor,
} from './types';

// ===========================================================================
// Event stream
// ===========================================================================

export interface AcpEventStream {
  stream: AsyncIterable<AcpEvent>;
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
}

// ===========================================================================
// Event operations
// ===========================================================================

export interface AcpEventOperations {
  /** Open a per-session event stream */
  openSessionStream(sessionId: string): AcpEventStream;

  /** Open the global event stream (all sessions) */
  openGlobalStream(): Promise<AcpEventStream>;

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
// Complete backend contract
// ===========================================================================

export interface AcpBackend {
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
  events: AcpEventOperations;
  permissions: AcpPermissionOperations;
  questions: AcpQuestionOperations;

  // -- pluggable settings UI -------------------------------------------

  /** Optional: provides backend-specific settings descriptor for the UI */
  readonly settingsProvider?: BackendSettingsProvider;
}
