/**
 * OpenCode → ACP event normalisation.
 *
 * Maps the raw SDK event types to normalised ACP semantic events
 * so that consumers (StreamBridge, etc.) never touch SDK types.
 */

import type { OpenCodeEvent, OpenCodeStreamEvent, StreamPart } from './sdk-events';
import type {
  PermissionAskedEvent,
  QuestionAskedEvent,
  SessionDiffEvent,
} from './sdk-events';
import type {
  AcpEvent,
  AcpStreamPart,
  AcpTextPart,
  AcpReasoningPart,
  AcpToolPart,
  AcpToolState,
  AcpStepPart,
  AcpPartUpdatedEvent,
  AcpPartDeltaEvent,
  AcpSessionIdleEvent,
  AcpSessionDiffEvent,
  AcpFileDiff,
  AcpPermissionRequestEvent,
  AcpPermissionReplyEvent,
  AcpQuestionRequestEvent,
  AcpQuestionReplyEvent,
  AcpQuestionRejectedEvent,
  AcpSessionLifecycleEvent,
  AcpSessionStatusEvent,
} from '../../acp/types';
import type {
  TextStreamPart,
  ReasoningStreamPart,
  StreamToolPart,
  ToolInput,
  StreamToolState,
  StepStartStreamPart,
  StepFinishStreamPart,
} from './sdk-events';

function getRawEventSessionId(event: OpenCodeEvent): string | undefined {
  switch (event.type) {
    case 'message.part.updated':
      return event.properties?.part?.sessionID;
    case 'message.part.delta':
      return (event.properties as { sessionID?: string }).sessionID;
    case 'session.created':
    case 'session.updated':
    case 'session.deleted':
      return (event.properties as { info?: { id?: string } }).info?.id;
    default:
      return (event.properties as { sessionID?: string } | undefined)?.sessionID;
  }
}

// ===========================================================================
// StreamPart → AcpStreamPart
// ===========================================================================

function normalizeToolState(state: StreamToolState): AcpToolState {
  const base: Pick<AcpToolState, 'status' | 'input'> = {
    status: state.status,
    input: state.input,
  };

  switch (state.status) {
    case 'pending':
      return { ...base, status: 'pending' };
    case 'running':
      return {
        ...base,
        status: 'running',
        title: state.title,
        metadata: state.metadata,
        startTime: state.time?.start,
      };
    case 'completed':
      return {
        ...base,
        status: 'completed',
        output: state.output,
        title: state.title,
        metadata: state.metadata,
        startTime: state.time?.start,
        endTime: state.time?.end,
      };
    case 'error':
      return {
        ...base,
        status: 'error',
        error: state.error,
        metadata: state.metadata,
        startTime: state.time?.start,
        endTime: state.time?.end,
      };
  }
}

function normalizeStreamPart(part: StreamPart): AcpStreamPart {
  const base = {
    id: part.id,
    messageId: part.messageID,
    sessionId: part.sessionID,
  };

  switch (part.type) {
    case 'text': {
      const text: AcpTextPart = {
        ...base,
        type: 'text',
        text: part.text,
        synthetic: (part).synthetic,
        ignored: (part).ignored,
        metadata: (part).metadata,
      };
      return text;
    }
    case 'reasoning': {
      const reasoning: AcpReasoningPart = {
        ...base,
        type: 'reasoning',
        text: part.text,
      };
      return reasoning;
    }
    case 'tool': {
      const tool: AcpToolPart = {
        ...base,
        type: 'tool',
        toolName: part.tool,
        callId: (part).callID,
        state: normalizeToolState((part).state),
      };
      return tool;
    }
    case 'step-start':
    case 'step-finish': {
      const stepPart = part;
      const step: AcpStepPart = {
        ...base,
        type: stepPart.type,
        reason: (stepPart as StepFinishStreamPart).reason,
        snapshot: stepPart.snapshot,
      };
      return step;
    }
    default: {
      const fallback: AcpTextPart = {
        ...base,
        type: 'text',
        text: '',
      };
      return fallback;
    }
  }
}

// ===========================================================================
// Diff helpers — handle both SDK FileDiff and custom SnapshotFileDiff
// ===========================================================================

interface RawFileDiff {
  file?: string;
  patch?: string;
  before?: string;
  after?: string;
  additions: number;
  deletions: number;
  status?: 'added' | 'deleted' | 'modified';
}

function toAcpFileDiff(d: RawFileDiff): AcpFileDiff {
  const file = d.file ?? '';
  return {
    file,
    patch: d.patch ?? `--- a/${file}\n+++ b/${file}\n`,
    additions: d.additions,
    deletions: d.deletions,
    status: d.status,
  };
}

function formatError(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const data = record.data;
  if (data && typeof data === 'object') {
    const message = (data as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }
  if (typeof record.message === 'string' && record.message.trim()) {
    return record.message;
  }
  if (typeof record.name === 'string' && record.name.trim()) {
    return record.name;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ===========================================================================
// PermissionAskedEvent → AcpPermissionRequestEvent
// ===========================================================================

function normalizePermissionAsked(ev: PermissionAskedEvent): AcpPermissionRequestEvent {
  return {
    type: 'permission.asked',
    permissionId: ev.properties.id,
    sessionId: ev.properties.sessionID,
    permission: ev.properties.permission,
    patterns: ev.properties.patterns,
    metadata: (ev.properties as { [key: string]: unknown }).metadata as Record<string, unknown>,
    always: ev.properties.always,
    tool: ev.properties.tool
      ? { messageId: ev.properties.tool.messageID, callId: ev.properties.tool.callID }
      : undefined,
  };
}

// ===========================================================================
// QuestionAskedEvent → AcpQuestionRequestEvent
// ===========================================================================

function normalizeQuestionAsked(ev: QuestionAskedEvent): AcpQuestionRequestEvent {
  const props = ev.properties;
  return {
    type: 'question.asked',
    questionId: props.id,
    sessionId: props.sessionID,
    questions: props.questions.map(q => ({
      question: q.question,
      header: q.header,
      options: q.options.map(o => ({ label: o.label, description: o.description })),
      multiple: q.multiple,
      custom: q.custom,
    })),
    tool: props.tool ? { messageId: props.tool.messageID, callId: props.tool.callID } : undefined,
  };
}

// ===========================================================================
// SessionDiffEvent → AcpSessionDiffEvent
// ===========================================================================

function normalizeSessionDiff(ev: { properties: { sessionID: string; diff: RawFileDiff[] } }): AcpSessionDiffEvent {
  return {
    type: 'session.diff',
    sessionId: ev.properties.sessionID,
    diffs: ev.properties.diff.map(toAcpFileDiff),
  };
}

// ===========================================================================
// Top-level normaliser: OpenCodeEvent → AcpEvent[]
// ===========================================================================

/**
 * Normalise a single OpenCode event into zero or more ACP events.
 * Most map 1:1, but some may produce multiple events or none.
 */
export function normalizeEvent(event: OpenCodeEvent): AcpEvent[] {
  switch (event.type) {
    // ---- Server lifecycle ----
    case 'server.connected':
      return [{ type: 'server.connected' }];

    // ---- Session lifecycle ----
    case 'session.created':
    case 'session.updated': {
      const props = event.properties as { info?: { id?: string; title?: string; parentID?: string } };
      return [{
        type: event.type,
        sessionId: props?.info?.id ?? '',
        parentId: props?.info?.parentID,
        title: props?.info?.title,
      }];
    }
    case 'session.deleted': {
      const props = event.properties as { info?: { id?: string } };
      return [{
        type: event.type as 'session.deleted',
        sessionId: props?.info?.id ?? '',
      }];
    }
    case 'session.error': {
      const props = event.properties as { [key: string]: unknown } | undefined;
      const err: AcpSessionLifecycleEvent = {
        type: 'session.error',
        sessionId: props?.sessionID as string ?? '',
        error: formatError(props?.error),
      };
      return [err];
    }

    // ---- Session idle ----
    case 'session.idle': {
      const idle: AcpSessionIdleEvent = {
        type: 'session.idle',
        sessionId: event.properties?.sessionID,
      };
      return [idle];
    }

    // ---- Session diff ----
    case 'session.diff':
      return [normalizeSessionDiff(event)];

    // ---- Message parts ----
    case 'message.part.updated': {
      const part = normalizeStreamPart(event.properties.part);
      const updated: AcpPartUpdatedEvent = {
        type: 'part.updated',
        sessionId: getRawEventSessionId(event),
        part,
        delta: event.properties.delta,
      };
      return [updated];
    }

    case 'message.part.delta': {
      const delta: AcpPartDeltaEvent = {
        type: 'part.delta',
        partId: event.properties.partID,
        delta: event.properties.delta,
        field: event.properties.field,
        sessionId: getRawEventSessionId(event),
      };
      return [delta];
    }

    case 'message.removed':
      return [{
        type: 'session.updated' as const,
        sessionId: (event.properties as { [key: string]: unknown } | undefined)?.sessionID as string ?? '',
      }];

    // ---- Permissions ----
    case 'permission.asked':
      return [normalizePermissionAsked(event)];

    case 'permission.replied': {
      // SDK v2 EventPermissionReplied uses requestID/reply (not permissionID/response)
      const props = event.properties as { sessionID: string; requestID: string; reply: string };
      const replied: AcpPermissionReplyEvent = {
        type: 'permission.replied',
        sessionId: props.sessionID,
        permissionId: props.requestID,
        response: props.reply,
      };
      return [replied];
    }

    // ---- Questions ----
    case 'question.asked':
      return [normalizeQuestionAsked(event)];

    case 'question.replied': {
      const qProps = event.properties as { sessionID: string; requestID: string };
      const qReplied: AcpQuestionReplyEvent = {
        type: 'question.replied',
        sessionId: qProps.sessionID,
        requestId: qProps.requestID,
      };
      return [qReplied];
    }

    case 'question.rejected': {
      const qProps = event.properties;
      const qRejected: AcpQuestionRejectedEvent = {
        type: 'question.rejected',
        sessionId: qProps.sessionID,
        requestId: qProps.requestID,
      };
      return [qRejected];
    }

    // ---- Session status ----
    case 'session.status': {
      const props = event.properties as { sessionID: string; status: { type: string; [key: string]: unknown } };
      const statusEvent: AcpSessionStatusEvent = {
        type: 'session.status',
        sessionId: props.sessionID,
        status: props.status as AcpSessionStatusEvent['status'],
      };
      return [statusEvent];
    }

    default:
      return [];
  }
}

/**
 * Normalise a stream event (which may be wrapped in a global envelope).
 */
export function normalizeStreamEvent(event: OpenCodeStreamEvent): AcpEvent[] {
  if ('directory' in event && 'payload' in event) {
    // Global event envelope — unwrap
    return normalizeEvent(event.payload);
  }
  return normalizeEvent(event);
}
