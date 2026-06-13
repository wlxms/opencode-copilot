/**
 * Serializable record types for the ACP event-stream persistence system.
 *
 * These types are designed to be safely JSON-serialized for disk I/O.
 * No VSCode or SDK imports allowed.
 */

// ===========================================================================
// File snapshot records (checkpoint store)
// ===========================================================================

/**
 * A point-in-time snapshot of a file's content.
 * Written to the append-only checkpoint JSONL file on every edit.
 */
export interface FileSnapshotRecord {
  /** The file URI (e.g. file:///path/to/file.ts) */
  uri: string;
  /** Full file content at this snapshot */
  content: string;
  /** Whether this is the file state before or after a tool edit */
  phase?: 'before' | 'after';
  /** 0-based user turn that produced this snapshot */
  turnIndex?: number;
  /** Monotonically increasing edit index within the session */
  editIndex: number;
  /** The tool call ID that produced this edit */
  toolCallId: string;
  /** ISO-8601 timestamp of the snapshot */
  timestamp: string;
  /** True when the file did not exist at this phase */
  missing?: boolean;
  /** VS Code edit/undo stop id returned by externalEdit for this tool edit. */
  undoStopId?: string;
}

export interface SerializableRequestDetails {
  /** 0-based user turn that owns this request. */
  turnIndex?: number;
  /** Stable provider request id when available; turn index fallback otherwise. */
  vscodeRequestId: string;
  /** Backend request id if exposed by the backend. */
  backendRequestId?: string;
  /** Map of backend tool call id to VS Code edit/undo stop id. */
  toolIdEditMap: Record<string, string>;
}

// ===========================================================================
// Serializable stream parts (v3 concept model)
// ===========================================================================

export interface SerializableStreamPartMeta {
  /** 0-based user turn that owns this stream part. */
  turnIndex: number;
  /** Stable VS Code request id when available; turn-index fallback otherwise. */
  requestId: string;
  /** Monotonic sequence within the turn. */
  sequence: number;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** Where this part came from. */
  source: 'acp-event' | 'synthetic' | 'restore' | 'unknown';
  /** Backend event type or other source discriminator. */
  sourceType?: string;
  /** Backend part id, when the source has one. */
  sourcePartId?: string;
  /** Backend tool call id, when this part belongs to a tool. */
  toolCallId?: string;
  /** VS Code edit/undo stop id, when this part belongs to an external edit. */
  editId?: string;
  /** File URI associated with this part, when any. */
  uri?: string;
}

export type SerializableStreamPartKind =
  | 'userPrompt'
  | 'assistantText'
  | 'assistantTextDelta'
  | 'reasoning'
  | 'reasoningDelta'
  | 'toolInvocation'
  | 'sessionLifecycle'
  | 'sessionDiff'
  | 'interactionRequest'
  | 'interactionResponse'
  | 'externalEdit'
  | 'externalEditMetadata'
  | 'rawAcpEvent';

export interface SerializableStreamPart<
  TKind extends SerializableStreamPartKind | string = string,
  TPayload = unknown,
> {
  kind: TKind;
  version: number;
  id: string;
  payload: TPayload;
  meta: SerializableStreamPartMeta;
}

export interface RawAcpEventStreamPartPayload<TEvent = unknown> {
  event: TEvent;
}

export type RawAcpEventStreamPart<TEvent = unknown> = SerializableStreamPart<
  'rawAcpEvent',
  RawAcpEventStreamPartPayload<TEvent>
>;

export interface UserPromptStreamPartPayload {
  text: string;
  partId?: string;
  messageId?: string;
}

export interface AssistantTextStreamPartPayload {
  partId: string;
  text: string;
  messageId?: string;
  synthetic?: boolean;
}

export interface AssistantTextDeltaStreamPartPayload {
  partId: string;
  delta: string;
  field?: string;
}

export interface ReasoningStreamPartPayload {
  partId: string;
  text: string;
  messageId?: string;
}

export interface ReasoningDeltaStreamPartPayload {
  partId: string;
  delta: string;
  field?: string;
}

export interface SerializableToolState {
  status: 'pending' | 'running' | 'completed' | 'error';
  input: Record<string, unknown>;
  output?: string;
  title?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  startTime?: number;
  endTime?: number;
}

export interface ToolInvocationStreamPartPayload {
  partId: string;
  toolName: string;
  callId?: string;
  state: SerializableToolState;
  messageId?: string;
  sessionId?: string;
}

export interface SessionLifecycleStreamPartPayload {
  eventType: 'session.created' | 'session.updated' | 'session.deleted' | 'session.error' | 'session.idle' | 'session.status' | 'server.connected' | 'server.heartbeat';
  sessionId?: string;
  title?: string;
  error?: string;
  status?: unknown;
}

export interface SessionDiffStreamPartPayload {
  sessionId: string;
  diffs: unknown[];
}

export interface InteractionRequestStreamPartPayload {
  interactionType: 'permission' | 'question';
  permissionId?: string;
  questionId?: string;
  sessionId?: string;
  permission?: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  questions?: unknown[];
  tool?: { messageId?: string; callId?: string };
}

export interface InteractionResponseStreamPartPayload {
  interactionType: 'permission' | 'question';
  eventType: 'permission.replied' | 'question.replied' | 'question.rejected';
  sessionId?: string;
  permissionId?: string;
  requestId?: string;
  response?: string;
}

export interface ExternalEditStreamPartPayload {
  toolCallId: string;
  editId: string;
  uri?: string;
}

export type KnownSerializableStreamPart =
  | SerializableStreamPart<'userPrompt', UserPromptStreamPartPayload>
  | SerializableStreamPart<'assistantText', AssistantTextStreamPartPayload>
  | SerializableStreamPart<'assistantTextDelta', AssistantTextDeltaStreamPartPayload>
  | SerializableStreamPart<'reasoning', ReasoningStreamPartPayload>
  | SerializableStreamPart<'reasoningDelta', ReasoningDeltaStreamPartPayload>
  | SerializableStreamPart<'toolInvocation', ToolInvocationStreamPartPayload>
  | SerializableStreamPart<'sessionLifecycle', SessionLifecycleStreamPartPayload>
  | SerializableStreamPart<'sessionDiff', SessionDiffStreamPartPayload>
  | SerializableStreamPart<'interactionRequest', InteractionRequestStreamPartPayload>
  | SerializableStreamPart<'interactionResponse', InteractionResponseStreamPartPayload>
  | SerializableStreamPart<'externalEdit', ExternalEditStreamPartPayload>
  | SerializableStreamPart<'externalEditMetadata', ExternalEditStreamPartPayload>
  | RawAcpEventStreamPart;

// ===========================================================================
// Meta
// ===========================================================================

export type SessionTitleSource =
  | 'manual'
  | 'copilot-style'
  | 'backend'
  | 'history'
  | 'placeholder'
  | 'restore'
  | 'legacy';

export interface SerializableSessionMeta {
  id: string;
  title?: string;
  titleSource?: SessionTitleSource;
  titleUpdatedAt?: string;
  provisionalTitle?: boolean;
  createdAt?: string;
  backendName?: string;
  description?: string;
  changeSummary?: {
    files: number;
    additions?: number;
    deletions?: number;
    paths?: string[];
  };
  status?: 'completed' | 'inProgress' | 'needsInput' | 'failed';
  archived?: boolean;
  changeApprovalState?: 'none' | 'pending' | 'accepted' | 'rejected' | 'partial';
  checkpointCursor?: {
    /** Inclusive user turn index accepted by the user. -1 means no turn accepted. */
    acceptedThroughTurn: number;
    /** Last turn whose pending checkpoints were replayed during local restore. */
    replayedThroughTurn?: number;
    /** Last turn where at least one checkpoint hunk conflicted. */
    lastConflictTurn?: number;
  };
  replaySummary?: {
    appliedFiles: number;
    skippedFiles: number;
    appliedHunks: number;
    skippedHunks: number;
    conflicts: Array<{ uri: string; reason: string; turnIndex?: number }>;
  };
  requestDetails?: SerializableRequestDetails[];
}
