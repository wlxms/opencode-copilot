/**
 * ACP (Agent Communication Protocol) domain types.
 *
 * These are protocol-agnostic abstractions that any backend adapter
 * must map to/from. No VSCode or SDK imports allowed.
 */

// ===========================================================================
// Server lifecycle
// ===========================================================================

export type AcpServerStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface AcpServerInfo {
  url: string | null;
  status: AcpServerStatus;
}

// ===========================================================================
// Models / providers
// ===========================================================================

export interface AcpModel {
  id: string;
  name?: string;
  /** Provider ID (used for API calls) */
  provider?: string;
  /** Human-readable provider name (used for UI only) */
  providerName?: string;
  capabilities?: string[];
}

export interface AcpProvider {
  id: string;
  name: string;
  models: AcpModel[];
}

// ===========================================================================
// Sessions
// ===========================================================================

export interface AcpSessionInfo {
  id: string;
  title: string;
  createdAt: Date;
}

export type AcpSessionStatus = { type: 'idle' } | { type: 'busy' } | { type: 'retry'; attempt: number; message: string; next: number };

export interface AcpChildSessionInfo {
  id: string;
  parentID?: string;
}

export interface AcpTurnMapping {
  turnIndex: number;
  messageId: string;
}

// ===========================================================================
// Stream parts (normalised semantic parts from events)
// ===========================================================================

export type AcpPartType =
  | 'text'
  | 'reasoning'
  | 'tool'
  | 'file'
  | 'agent'
  | 'step-start'
  | 'step-finish';

export type AcpToolStatus = 'pending' | 'running' | 'completed' | 'error';

export interface AcpToolState {
  status: AcpToolStatus;
  input: Record<string, unknown>;
  output?: string;
  title?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  startTime?: number;
  endTime?: number;
}

export interface AcpBasePart {
  id: string;
  type: AcpPartType;
  messageId?: string;
  sessionId?: string;
}

export interface AcpTextPart extends AcpBasePart {
  type: 'text';
  text: string;
  synthetic?: boolean;
}

export interface AcpReasoningPart extends AcpBasePart {
  type: 'reasoning';
  text: string;
}

export interface AcpToolPart extends AcpBasePart {
  type: 'tool';
  toolName: string;
  callId?: string;
  state: AcpToolState;
}

export interface AcpStepPart extends AcpBasePart {
  type: 'step-start' | 'step-finish';
  reason?: string;
  snapshot?: string;
  cost?: number;
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
}

export type AcpStreamPart = AcpTextPart | AcpReasoningPart | AcpToolPart | AcpStepPart;

// ===========================================================================
// Normalised semantic events
// ===========================================================================

export type AcpEventType =
  | 'part.updated'
  | 'part.delta'
  | 'session.idle'
  | 'session.status'
  | 'session.diff'
  | 'session.created'
  | 'session.updated'
  | 'session.deleted'
  | 'session.error'
  | 'permission.asked'
  | 'permission.replied'
  | 'server.connected'
  | 'server.heartbeat';

export interface AcpPartUpdatedEvent {
  type: 'part.updated';
  part: AcpStreamPart;
  delta?: string;
}

export interface AcpPartDeltaEvent {
  type: 'part.delta';
  partId: string;
  delta: string;
  field?: string;
}

export interface AcpSessionIdleEvent {
  type: 'session.idle';
  sessionId?: string;
}

export interface AcpFileDiff {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status?: 'added' | 'deleted' | 'modified';
}

export interface AcpSessionDiffEvent {
  type: 'session.diff';
  sessionId: string;
  diffs: AcpFileDiff[];
}

export interface AcpSessionLifecycleEvent {
  type: 'session.created' | 'session.updated' | 'session.deleted' | 'session.error';
  sessionId: string;
  title?: string;
  error?: string;
}

export interface AcpPermissionRequestEvent {
  type: 'permission.asked';
  permissionId: string;
  sessionId: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageId: string; callId: string };
}

export interface AcpPermissionReplyEvent {
  type: 'permission.replied';
  sessionId: string;
  permissionId: string;
  response: string;
}

export interface AcpServerLifecycleEvent {
  type: 'server.connected' | 'server.heartbeat';
}

export interface AcpSessionStatusEvent {
  type: 'session.status';
  sessionId: string;
  status: AcpSessionStatus;
}

export type AcpEvent =
  | AcpPartUpdatedEvent
  | AcpPartDeltaEvent
  | AcpSessionIdleEvent
  | AcpSessionDiffEvent
  | AcpSessionLifecycleEvent
  | AcpSessionStatusEvent
  | AcpPermissionRequestEvent
  | AcpPermissionReplyEvent
  | AcpServerLifecycleEvent;

// ===========================================================================
// Result wrapper
// ===========================================================================

export interface AcpResult<T, E = string> {
  data?: T;
  error?: E;
}

// ===========================================================================
// Permission responses
// ===========================================================================

export type AcpPermissionResponse = 'once' | 'always' | 'reject';

// ===========================================================================
// Agents
// ===========================================================================

export interface AcpAgent {
  id: string;
  name?: string;
  description?: string;
  model?: string;
  mode?: 'subagent' | 'primary' | 'all';
  hidden?: boolean;
}

// ===========================================================================
// Configuration
// ===========================================================================

export interface AcpAgentConfig {
  model?: string;
  variant?: string;
  temperature?: number;
  top_p?: number;
  prompt?: string;
  tools?: Record<string, boolean>;
  disable?: boolean;
  description?: string;
  mode?: 'subagent' | 'primary' | 'all';
  hidden?: boolean;
  steps?: number;
  maxSteps?: number;
}

export interface AcpProviderConfig {
  api?: string;
  name?: string;
  id?: string;
  options?: {
    apiKey?: string;
    baseURL?: string;
  };
  models?: Record<string, { name?: string }>;
}

export interface AcpConfig {
  model?: string;
  small_model?: string;
  default_agent?: string;
  disabled_providers?: string[];
  enabled_providers?: string[];
  agent?: Record<string, AcpAgentConfig>;
  provider?: Record<string, AcpProviderConfig>;
}

export interface AcpModelSelection {
  providerID: string;
  modelID: string;
  variant?: string;
}
