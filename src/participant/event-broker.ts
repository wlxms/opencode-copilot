import type { OpenCodeClient } from '../types';
import type { OpenCodeEvent, OpenCodeEventStream, OpenCodeStreamEvent } from '../types/events';

interface LoggerLike {
  appendLine(message: string): void;
}

interface SessionChannel {
  push(event: OpenCodeStreamEvent): void;
  close(): void;
  stream(): AsyncIterable<OpenCodeStreamEvent>;
}

class BufferedSessionChannel implements SessionChannel {
  private queue: OpenCodeStreamEvent[] = [];
  private waiters: Array<(result: IteratorResult<OpenCodeStreamEvent>) => void> = [];
  private closed = false;

  push(event: OpenCodeStreamEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }
    this.queue.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined, done: true });
    }
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
    if (!channel) return;
    channel.close();
    this.sessionChannels.delete(sessionId);
    this.clearSessionParts(sessionId);
    this.log(`close session stream: sessionID=${sessionId}`);
  }

  private async connect(client: OpenCodeClient): Promise<void> {
    const events = await client.global.event();
    this.log('subscribed to /global/event SSE stream');

    this.pumpPromise = this.pump(events);
  }

  private async pump(events: OpenCodeEventStream): Promise<void> {
    try {
      for await (const rawEvent of events.stream) {
        this.dispatch(rawEvent);
      }
      this.log('global event stream completed');
      this.closeAllSessionStreams();
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
    if (event.type === 'permission.asked') {
      const p = event.properties;
      this.log(
        `dispatch permission.asked: permissionID=${p.id}, sessionID=${p.sessionID}, ` +
        `permission=${p.permission}, callID=${p.tool?.callID ?? 'none'}, rawEnvelope=${'payload' in rawEvent}`,
      );
    }
    if (!sessionId) {
      if (event.type === 'permission.asked') {
        this.log('drop permission.asked: no sessionID resolved');
      }
      return;
    }

    const channel = this.sessionChannels.get(sessionId);
    if (!channel) {
      if (event.type === 'permission.asked') {
        this.log(`drop permission.asked: no open channel for sessionID=${sessionId}`);
      }
      return;
    }

    channel.push(rawEvent);
    if (event.type === 'permission.asked') {
      this.log(`forward permission.asked to session channel: sessionID=${sessionId}`);
    }
    if (event.type === 'session.idle') {
      channel.close();
      this.sessionChannels.delete(sessionId);
      this.clearSessionParts(sessionId);
      this.log(`session idle: sessionID=${sessionId}`);
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

  private clearSessionParts(sessionId: string): void {
    const parts = this.sessionParts.get(sessionId);
    if (!parts) return;
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
}

function unwrapStreamEvent(event: OpenCodeStreamEvent): OpenCodeEvent {
  return 'payload' in event ? event.payload : event;
}

function getEventSessionIdFromProperties(event: OpenCodeEvent): string | undefined {
  const withProperties = event as OpenCodeEvent & {
    properties?: { sessionID?: string; info?: { sessionID?: string } };
  };
  return withProperties.properties?.sessionID ?? withProperties.properties?.info?.sessionID;
}
