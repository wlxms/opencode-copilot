import type { OpenCodeClient } from './sdk-types';
import type { OpenCodeEvent, OpenCodeEventStream, OpenCodeStreamEvent } from './sdk-events';

interface LoggerLike {
  appendLine(message: string): void;
}

interface SessionChannel {
  push(event: OpenCodeStreamEvent): void;
  close(): void;
  isIdle(): void;
  stream(): AsyncIterable<OpenCodeStreamEvent>;
}

class BufferedSessionChannel implements SessionChannel {
  private queue: OpenCodeStreamEvent[] = [];
  private waiters: Array<(result: IteratorResult<OpenCodeStreamEvent>) => void> = [];
  private closed = false;
  /**
   * Set to true when `session.idle` is received. The channel stays open
   * so consumers can continue receiving events (e.g. from subagents),
   * but `idle` flag lets consumers know the parent turn is logically done.
   */
  private idle = false;

  push(event: OpenCodeStreamEvent): void {
    if (this.closed) {return;}
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }
    this.queue.push(event);
  }

  close(): void {
    if (this.closed) {return;}
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  isIdle(): boolean {
    return this.idle;
  }

  async *stream(): AsyncIterable<OpenCodeStreamEvent> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift() as OpenCodeStreamEvent;
        continue;
      }
      if (this.closed) {
        return;
      }

      const result = await new Promise<IteratorResult<OpenCodeStreamEvent>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (result.done) {
        return;
      }
      yield result.value;
    }
  }
}

export class GlobalEventBroker {
  private connectPromise: Promise<void> | null = null;
  private pumpPromise: Promise<void> | null = null;
  private activeClient: OpenCodeClient | null = null;
  private logger?: LoggerLike;
  private sessionChannels: Map<string, SessionChannel> = new Map();
  private partSessions: Map<string, string> = new Map();
  private sessionParts: Map<string, Set<string>> = new Map();
  private pendingPartDeltas: Map<string, OpenCodeStreamEvent[]> = new Map();
  private childToParent: Map<string, string> = new Map();

  async ensureStarted(client: OpenCodeClient, logger?: LoggerLike): Promise<void> {
    if (logger) {
      this.logger = logger;
    }

    if (this.connectPromise && this.activeClient === client) {
      await this.connectPromise;
      return;
    }

    if (!this.connectPromise) {
      this.activeClient = client;
      this.connectPromise = this.connect(client);
    }

    await this.connectPromise;
  }

  openSessionStream(sessionId: string): OpenCodeEventStream {
    const existing = this.sessionChannels.get(sessionId);
    if (existing) {
      existing.close();
    }

    const channel = new BufferedSessionChannel();
    this.sessionChannels.set(sessionId, channel);
    this.log(`open session stream: sessionID=${sessionId}`);
    return { stream: channel.stream() };
  }

  closeSessionStream(sessionId: string): void {
    const channel = this.sessionChannels.get(sessionId);
    if (!channel) {return;}
    channel.close();
    this.sessionChannels.delete(sessionId);
    this.clearSessionParts(sessionId);
    // Clean up child→parent mappings for this parent
    for (const [childId, parentId] of this.childToParent.entries()) {
      if (parentId === sessionId) {
        this.childToParent.delete(childId);
      }
    }
    this.log(`close session stream: sessionID=${sessionId}`);
  }

  private async connect(client: OpenCodeClient): Promise<void> {
    this.log('connecting to /global/event SSE stream');
    this.pumpPromise = this.pumpWithReconnect(client).catch(() => {
      // Rejection is expected when the client/stream throws (e.g. during tests or shutdown).
      // The error is logged inside pumpWithReconnect; no need to propagate further.
    });
  }

  /**
   * Pump events from the global SSE stream with automatic reconnection.
   * When the stream ends normally (server closes connection), reconnect
   * after a short delay to continue receiving events (e.g. after question replies).
   * On error, close all session streams and reset state.
   */
  private async pumpWithReconnect(client: OpenCodeClient): Promise<void> {
    let reconnectDelay = 1000; // start with 1s, exponential backoff
    const maxDelay = 30_000;

    try {
      while (true) {
        const events = (await client.global.event()) as { stream: AsyncIterable<OpenCodeStreamEvent> };
        this.log('subscribed to /global/event SSE stream');
        reconnectDelay = 1000; // reset on successful connect

        for await (const rawEvent of events.stream) {
          this.dispatch(rawEvent);
        }

        // Stream ended normally — server closed the connection.
        // Don't close session channels; instead reconnect to receive
        // subsequent events (e.g. after a question.asked reply).
        this.log(`global event stream completed, reconnecting in ${reconnectDelay}ms...`);

        // Only reconnect if there are still active consumers
        if (this.sessionChannels.size === 0) {
          this.log('no active session channels after stream end, stopping');
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, reconnectDelay));
        reconnectDelay = Math.min(reconnectDelay * 2, maxDelay);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log(`global event stream error: ${msg}`);
      this.closeAllSessionStreams();
      throw error;
    } finally {
      this.connectPromise = null;
      this.pumpPromise = null;
      this.activeClient = null;
    }
  }

  private dispatch(rawEvent: OpenCodeStreamEvent): void {
    const event = unwrapStreamEvent(rawEvent);
    const sessionId = this.getSessionId(event);
    this.log(`dispatch: type=${event.type}, sessionId=${sessionId ?? 'none'}, channels=${this.sessionChannels.size}`);
    if (!sessionId) {
      if (event.type === 'message.part.delta') {
        this.bufferPendingPartDelta(event.properties.partID, rawEvent);
      }
      return;
    }

    let channel = this.sessionChannels.get(sessionId);
    if (!channel) {
      // No direct channel — trace the parent chain upward (child → parent → grandparent)
      // to find a channel that's listening. This handles nested background tasks
      // where grandchildren events need to reach the root parent's channel.
      let currentId = sessionId;
      const visited = new Set<string>();
      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const parentId = this.childToParent.get(currentId);
        if (!parentId) {break;}
        channel = this.sessionChannels.get(parentId);
        if (channel) {
          this.log(`forwarding descendant event: childSessionId=${sessionId} → parentId=${parentId}, type=${event.type}`);
          break;
        }
        currentId = parentId;
      }
    }
    if (!channel) {
      return; // truly no channel, drop event
    }

    for (const eventToPush of this.eventsForDispatch(rawEvent, event)) {
      channel.push(eventToPush);
    }
    if (event.type === 'session.idle') {
      // Mark the channel as idle but do NOT close it. The consumer
      // (StreamBridge) decides when to actually close the stream —
      // e.g. after all active subagent scopes are resolved.
      // This prevents losing events from still-running subagents.
      channel.isIdle();
      this.log(`session idle (channel kept open): sessionID=${sessionId}`);
    }
  }

  private getSessionId(event: OpenCodeEvent): string | undefined {
    switch (event.type) {
      case 'message.part.updated': {
        const sessionId = event.properties?.part?.sessionID;
        if (sessionId) {
          this.trackPart(event.properties.part.id, sessionId);
        }
        return sessionId;
      }
      case 'message.part.delta':
        return this.partSessions.get(event.properties.partID);
      case 'session.idle':
        return event.properties?.sessionID;
      case 'permission.asked':
        return event.properties?.sessionID;
      case 'permission.replied':
        return event.properties?.sessionID;
      case 'question.asked':
        return event.properties?.sessionID;
      case 'question.replied':
        return event.properties.sessionID;
      case 'question.rejected':
        return event.properties.sessionID;
      case 'session.created':
      case 'session.updated':
      case 'session.deleted': {
        // properties.info.id contains the session ID (from SDK Session type)
        const { info } = event.properties;
        const id: string = info.id;
        if (event.type === 'session.created' && info.parentID) {
          // Auto-detect child sessions from parentID field
          this.childToParent.set(id, info.parentID);
          this.log(`child session detected: childId=${id}, parentId=${info.parentID}`);
        }
        return id;
      }
      case 'session.status':
        return event.properties.sessionID;
      default:
        return getEventSessionIdFromProperties(event);
    }
  }

  private trackPart(partId: string, sessionId: string): void {
    this.partSessions.set(partId, sessionId);
    let parts = this.sessionParts.get(sessionId);
    if (!parts) {
      parts = new Set<string>();
      this.sessionParts.set(sessionId, parts);
    }
    parts.add(partId);
  }

  private bufferPendingPartDelta(partId: string | undefined, event: OpenCodeStreamEvent): void {
    if (!partId) {return;}
    const pending = this.pendingPartDeltas.get(partId) ?? [];
    pending.push(event);
    this.pendingPartDeltas.set(partId, pending);
  }

  private eventsForDispatch(
    rawEvent: OpenCodeStreamEvent,
    event: OpenCodeEvent,
  ): OpenCodeStreamEvent[] {
    if (event.type !== 'message.part.updated') {
      return [rawEvent];
    }

    const partId = event.properties?.part?.id;
    if (!partId) {
      return [rawEvent];
    }

    const pending = this.pendingPartDeltas.get(partId);
    if (!pending || pending.length === 0) {
      return [rawEvent];
    }

    this.pendingPartDeltas.delete(partId);
    return [
      ...pending,
      rawEvent,
    ];
  }

  private clearSessionParts(sessionId: string): void {
    const parts = this.sessionParts.get(sessionId);
    if (!parts) {return;}
    for (const partId of parts) {
      this.partSessions.delete(partId);
    }
    this.sessionParts.delete(sessionId);
  }

  private closeAllSessionStreams(): void {
    for (const [sessionId, channel] of this.sessionChannels.entries()) {
      channel.close();
      this.clearSessionParts(sessionId);
    }
    this.sessionChannels.clear();
  }

  private log(message: string): void {
    this.logger?.appendLine(`[broker] ${message}`);
  }

  // -------------------------------------------------------------------
  // Public query methods for session hierarchy
  // -------------------------------------------------------------------

  /**
   * Check whether `sessionId` is a descendant of `ancestorId` in the
   * child→parent session hierarchy.
   * Walks up the childToParent chain until it finds `ancestorId` or runs out.
   */
  isDescendantOf(sessionId: string, ancestorId: string): boolean {
    let current = sessionId;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      const parent = this.childToParent.get(current);
      if (!parent) {break;}
      if (parent === ancestorId) {return true;}
      current = parent;
    }
    return false;
  }

  /**
   * Find the parent session ID for a given session, or undefined if none.
   */
  getParentSession(sessionId: string): string | undefined {
    return this.childToParent.get(sessionId);
  }

  /**
   * Walk up the parent chain from `sessionId` and return the first session ID
   * that appears in `candidateIds`. Used by StreamBridge to find which scope
   * a grandchild event belongs to.
   */
  findAncestorIn(sessionId: string, candidateIds: Set<string>): string | undefined {
    let current = sessionId;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      if (candidateIds.has(current)) {return current;}
      const parent = this.childToParent.get(current);
      if (!parent) {break;}
      current = parent;
    }
    return undefined;
  }

  /**
   * Return all session IDs that are descendants of `parentId` in the
   * child→parent hierarchy (children, grandchildren, etc.).
   * Used for cascade-abort when the user cancels a parent session.
   */
  getDescendantSessions(parentId: string): string[] {
    const descendants: string[] = [];
    // Build reverse index: parent → children
    const parentToChildren = new Map<string, string[]>();
    for (const [childId, pid] of this.childToParent.entries()) {
      let children = parentToChildren.get(pid);
      if (!children) {
        children = [];
        parentToChildren.set(pid, children);
      }
      children.push(childId);
    }
    // BFS from parentId
    const queue = parentToChildren.get(parentId) ?? [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      descendants.push(id);
      const kids = parentToChildren.get(id);
      if (kids) {queue.push(...kids);}
    }
    return descendants;
  }
}

function unwrapStreamEvent(event: OpenCodeStreamEvent): OpenCodeEvent {
  return 'payload' in event ? event.payload : event;
}

function getEventSessionIdFromProperties(event: OpenCodeEvent): string | undefined {
  if (!('properties' in event)) {return undefined;}
  const props = event.properties;
  if (!props || typeof props !== 'object') {return undefined;}

  const propsObj = props as Record<string, unknown>;

  if (typeof propsObj.sessionID === 'string') {
    return propsObj.sessionID;
  }

  if (propsObj.info && typeof propsObj.info === 'object') {
    const info = propsObj.info as Record<string, unknown>;
    if (typeof info.sessionID === 'string') {
      return info.sessionID;
    }
  }

  return undefined;
}
