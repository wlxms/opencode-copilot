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
  /** Monotonically increasing edit index within the session */
  editIndex: number;
  /** The tool call ID that produced this edit */
  toolCallId: string;
  /** ISO-8601 timestamp of the snapshot */
  timestamp: string;
}

// ===========================================================================
// Part variants (v1)
// ===========================================================================

export interface SerializableTextPart {
  type: 'text';
  text: string;
  synthetic?: boolean;
}

export interface SerializableReasoningPart {
  type: 'reasoning';
  text: string;
  signature?: string;
}

export interface SerializableToolPart {
  type: 'tool';
  toolName: string;
  callId?: string;
  state: {
    status: 'pending' | 'running' | 'completed' | 'error';
    input: Record<string, unknown>;
    output?: string;
    title?: string;
    error?: string;
    metadata?: Record<string, unknown>;
    startTime?: number;
    endTime?: number;
  };
}

export interface SerializableStepPart {
  type: 'step-start' | 'step-finish';
  reason?: string;
  snapshot?: string;
  cost?: number;
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
}

// ===========================================================================
// Part union
// ===========================================================================

export type SerializablePart =
  | SerializableTextPart
  | SerializableReasoningPart
  | SerializableToolPart
  | SerializableStepPart;

// ===========================================================================
// Line types
// ===========================================================================

export type SerializableLineType =
  | 'version' | 'meta' | 'turn-start' | 'part' | 'turn-end'   // v1
  | 'event' | 'snapshot';                                       // v2

// ===========================================================================
// Envelope
// ===========================================================================

export interface SerializableLine {
  v: number;
  t: string;     // Runtime-checked via parseLine(); see SerializableLineType for known values
  d: unknown;
}

// ===========================================================================
// Turns
// ===========================================================================

export interface SerializableRequestTurn {
  type: 'request';
  parts: SerializablePart[];
}

export interface SerializableResponseTurn {
  type: 'response';
  parts: SerializablePart[];
}

export type SerializableTurn = SerializableRequestTurn | SerializableResponseTurn;

// ===========================================================================
// Meta
// ===========================================================================

export interface SerializableSessionMeta {
  id: string;
  title?: string;
  createdAt?: string;
  backendName?: string;
}
