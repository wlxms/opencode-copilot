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
  | 'question.asked'
  | 'question.replied'
  | 'question.rejected'
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

// ===========================================================================
// Question events
// ===========================================================================

export interface AcpQuestionOption {
  label: string;
  description: string;
}

export interface AcpQuestionInfo {
  question: string;
  header: string;
  options: Array<AcpQuestionOption>;
  multiple?: boolean;
  custom?: boolean;
}

export interface AcpQuestionRequestEvent {
  type: 'question.asked';
  questionId: string;
  sessionId: string;
  questions: Array<AcpQuestionInfo>;
  tool?: { messageId: string; callId: string };
}

export interface AcpQuestionReplyEvent {
  type: 'question.replied';
  sessionId: string;
  requestId: string;
}

export interface AcpQuestionRejectedEvent {
  type: 'question.rejected';
  sessionId: string;
  requestId: string;
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
  | AcpQuestionRequestEvent
  | AcpQuestionReplyEvent
  | AcpQuestionRejectedEvent
  | AcpServerLifecycleEvent;

// ===========================================================================
// Result wrapper
// ===========================================================================

export interface AcpResult<T, E = string> {
  data?: T;
  error?: E;
}

// ===========================================================================
// Message history (for session history restoration)
// ===========================================================================

export interface AcpHistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  /** Extracted text content (from parts for user, or joined text parts for assistant) */
  text: string;
  /** Tool call summaries for assistant messages */
  toolCalls?: Array<{ toolName: string; callId?: string }>;
  metadata?: Record<string, unknown>;
}

export interface AcpMessageHistory {
  items: AcpHistoryMessage[];
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
  model?: string | { modelID: string; providerID: string };
  mode?: 'subagent' | 'primary' | 'all';
  hidden?: boolean;
}

/**
 * Returns true if an agent should appear in user-selectable pickers.
 * Excludes hidden agents and subagent-mode agents so users only see
 * agents they can intentionally invoke.
 */
export function isUserSelectableAgent(agent: AcpAgent): boolean {
  return !agent.hidden && agent.mode !== 'subagent';
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

// ===========================================================================
// Backend Settings Descriptor (pluggable settings UI)
// ===========================================================================

export interface TextField {
  type: 'text';
  key: string;
  label: string;
  description?: string;
  placeholder?: string;
}

export interface SelectField {
  type: 'select';
  key: string;
  label: string;
  description?: string;
  options: Array<{ value: string; label: string }>;
}

export interface ToggleField {
  type: 'toggle';
  key: string;
  label: string;
  description?: string;
}

export interface InfoCardsField {
  type: 'info-cards';
  key: string;
  items: Array<{
    title: string;
    details: Array<{ label: string; value: string }>;
  }>;
}

/**
 * A map field: each item gets the same set of sub-fields.
 * Values are stored as: { [mapKey]: { [itemId]: { [subFieldKey]: value } } }
 */
export interface MapField {
  type: 'map';
  key: string;
  label: string;
  description?: string;
  items: Array<{ id: string; label: string; description?: string }>;
  fields: Array<TextField | SelectField | ToggleField>;
}

export type SettingsField = TextField | SelectField | ToggleField | InfoCardsField | MapField;

export interface SettingsFieldGroup {
  key: string;
  title?: string;
  description?: string;
  collapsible?: boolean;
  fields: SettingsField[];
}

export interface BackendSettingsTab {
  id: string;
  title: string;
  groups: SettingsFieldGroup[];
}

export interface BackendSettingsDescriptor {
  tabs: BackendSettingsTab[];
  values: Record<string, unknown>;
}
