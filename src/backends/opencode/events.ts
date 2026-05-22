/**
 * OpenCode → ACP event normalisation.
 *
 * Maps the raw SDK event types to normalised ACP semantic events
 * so that consumers (StreamBridge, etc.) never touch SDK types.
 */

import type { OpenCodeEvent, OpenCodeStreamEvent, StreamPart } from './sdk-events';
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
  AcpSessionLifecycleEvent,
} from '../../acp/types';

import type {
  TextStreamPart,
  ReasoningStreamPart,
  StreamToolPart,
  ToolInput,
  StreamToolState,
  StepStartStreamPart,
  StepFinishStreamPart,
  PermissionAskedEvent,
  SessionDiffEvent,
} from './sdk-events';

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
        metadata: state.metadata as Record<string, unknown> | undefined,
        startTime: state.time?.start,
      };
    case 'completed':
      return {
        ...base,
        status: 'completed',
        output: state.output,
        title: state.title,
        metadata: state.metadata as Record<string, unknown> | undefined,
        startTime: state.time?.start,
        endTime: state.time?.end,
      };
    case 'error':
      return {
        ...base,
        status: 'error',
        error: state.error,
        metadata: state.metadata as Record<string, unknown> | undefined,
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
        synthetic: (part as TextStreamPart).synthetic,
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
        callId: (part as StreamToolPart).callID,
        state: normalizeToolState((part as StreamToolPart).state),
      };
      return tool;
    }
    case 'step-start':
    case 'step-finish': {
      const stepPart = part as StepStartStreamPart | StepFinishStreamPart;
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
  file: string;
  patch?: string;
  before?: string;
  after?: string;
  additions: number;
  deletions: number;
  status?: 'added' | 'deleted' | 'modified';
}

function toAcpFileDiff(d: RawFileDiff): AcpFileDiff {
  return {
    file: d.file,
    patch: d.patch ?? `--- a/${d.file}\n+++ b/${d.file}\n`,
    additions: d.additions,
    deletions: d.deletions,
    status: d.status,
  };
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
    case 'session.updated':
    case 'session.deleted': {
      const props = event.properties as { [key: string]: unknown } | undefined;
      const lc: AcpSessionLifecycleEvent = {
        type: event.type,
        sessionId: props?.sessionID as string ?? '',
        title: props?.title as string | undefined,
      };
      return [lc];
    }
    case 'session.error': {
      const props = event.properties as { [key: string]: unknown } | undefined;
      const err: AcpSessionLifecycleEvent = {
        type: 'session.error',
        sessionId: props?.sessionID as string ?? '',
        error: props?.error as string | undefined,
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
      return [normalizeSessionDiff(event as { properties: { sessionID: string; diff: RawFileDiff[] } })];

    // ---- Message parts ----
    case 'message.part.updated': {
      const updated: AcpPartUpdatedEvent = {
        type: 'part.updated',
        part: normalizeStreamPart(event.properties.part),
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
      return [normalizePermissionAsked(event as PermissionAskedEvent)];

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
  return normalizeEvent(event as OpenCodeEvent);
}
