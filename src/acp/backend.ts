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

  prompt(
    id: string,
    text: string,
    directory?: string,
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
}

// ===========================================================================
// Config operations
// ===========================================================================

export interface AcpConfigOperations {
  models(directory?: string): Promise<AcpResult<AcpModel[]>>;
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
}
