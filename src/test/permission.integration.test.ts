import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOpencodeClient as createOpencodeClientV2 } from '@opencode-ai/sdk/v2';
import { OpenCodeServerManager } from '../opencode/server';
import type { OpenCodeEvent } from '../types/events';
import type { OpenCodeStreamEvent } from '../types/events';

const describePermissionIntegration = process.env.OPENCODE_PERMISSION_INTEGRATION === '1'
  ? describe
  : describe.skip;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPermissionAskedEvent(event: OpenCodeEvent): event is Extract<OpenCodeEvent, { type: 'permission.asked' }> {
  return event.type === 'permission.asked';
}

async function collectEvents(
  stream: AsyncIterable<OpenCodeStreamEvent>,
  sink: OpenCodeEvent[],
  errors: unknown[],
): Promise<void> {
  try {
    for await (const rawEvent of stream) {
      sink.push('payload' in rawEvent ? rawEvent.payload : rawEvent);
    }
  } catch (error) {
    errors.push(error);
  }
}

async function waitForPermissionAsked(
  events: OpenCodeEvent[],
  timeoutMs: number,
): Promise<Extract<OpenCodeEvent, { type: 'permission.asked' }> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.find(isPermissionAskedEvent);
    if (found) {
      return found;
    }
    await sleep(100);
  }
  return null;
}

function summarizeEventTypes(events: OpenCodeEvent[]): string {
  return events.map((event) => event.type).join(',');
}

async function waitForV2PendingPermission(
  client: ReturnType<typeof createOpencodeClientV2>,
  directory: string,
  timeoutMs: number,
): Promise<{ id: string; sessionID: string; permission: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.permission.list({ directory });
    const list = result.data ?? [];
    const found = list[0];
    if (found) {
      return found;
    }
    await sleep(150);
  }
  return null;
}

async function waitForV2SessionIdle(
  client: ReturnType<typeof createOpencodeClientV2>,
  directory: string,
  sessionID: string,
  timeoutMs: number,
): Promise<boolean> {
  const stream = await client.event.subscribe({ directory });
  const deadline = Date.now() + timeoutMs;
  for await (const rawEvent of stream.stream) {
    const event = rawEvent;
    if (event.type === 'session.idle' && event.properties.sessionID === sessionID) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
  }
  return false;
}

describePermissionIntegration('permission integration', () => {
  it('observes permission.asked from a real server and can approve it', async () => {
    const manager = new OpenCodeServerManager();
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-permission-'));
    const helloFile = path.join(tmpDir, 'hello.txt');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(helloFile, 'hello\n', 'utf8');

    const globalEvents: OpenCodeEvent[] = [];
    const subscribedEvents: OpenCodeEvent[] = [];
    const streamErrors: unknown[] = [];

    try {
      await manager.start(tmpDir);
      const client = manager.getClient();
      expect(client).toBeTruthy();
      if (!client) {
        throw new Error('OpenCode client unavailable after start');
      }

      await client.config.update({
        body: { permission: { edit: 'ask' } },
        query: { directory: tmpDir },
      });

      const session = await client.session.create({
        body: {},
        query: { directory: tmpDir },
      });
      const sessionId = session.data?.id;
      expect(sessionId).toBeTruthy();
      if (!sessionId) {
        throw new Error(`Failed to create session: ${JSON.stringify(session)}`);
      }

      const globalStream = await client.global.event();
      const subscribedStream = await client.event.subscribe({
        query: { directory: tmpDir },
      });

      const globalCollector = collectEvents(globalStream.stream, globalEvents, streamErrors);
      const subscribedCollector = collectEvents(subscribedStream.stream, subscribedEvents, streamErrors);

      const promptPromise = client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{
            type: 'text',
            text: 'Edit hello.txt by appending exactly one line: integration permission check. Then briefly report what you changed.',
          }],
        },
        query: { directory: tmpDir },
      });

      const permissionAsked = await waitForPermissionAsked(subscribedEvents, 30000)
        ?? await waitForPermissionAsked(globalEvents, 1000);
      expect(
        permissionAsked,
        `No permission.asked event observed. global=${summarizeEventTypes(globalEvents)} subscribed=${summarizeEventTypes(subscribedEvents)}`,
      ).toBeTruthy();
      if (!permissionAsked) {
        throw new Error('permission.asked was not observed on event.subscribe()');
      }

      expect(permissionAsked.properties.sessionID).toBe(sessionId);
      expect(permissionAsked.properties.permission).toBe('edit');

      await client.postSessionIdPermissionsPermissionId({
        body: { response: 'once' },
        path: { id: sessionId, permissionID: permissionAsked.properties.id },
        query: { directory: tmpDir },
      });

      await Promise.race([
        promptPromise,
        sleep(30000).then(() => {
          throw new Error('Timed out waiting for prompt completion after permission approval');
        }),
      ]);

      expect(streamErrors).toEqual([]);

      const globalSawPermission = globalEvents.some(isPermissionAskedEvent);
      const subscribedSawPermission = subscribedEvents.some(isPermissionAskedEvent);

      expect(globalSawPermission || subscribedSawPermission).toBe(true);

      await Promise.race([globalCollector, sleep(500)]);
      await Promise.race([subscribedCollector, sleep(500)]);
    } finally {
      await manager.stop();
    }
  }, 120000);

  it('can complete an edit by polling pending permissions via v2 client', async () => {
    const manager = new OpenCodeServerManager();
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-permission-v2-'));
    const helloFile = path.join(tmpDir, 'hello.txt');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(helloFile, 'hello\n', 'utf8');

    try {
      const url = await manager.start(tmpDir);
      const client = manager.getClient();
      expect(client).toBeTruthy();
      if (!client) {
        throw new Error('OpenCode client unavailable after start');
      }

      await client.config.update({
        body: { permission: { edit: 'ask' } },
        query: { directory: tmpDir },
      });

      const session = await client.session.create({
        body: {},
        query: { directory: tmpDir },
      });
      const sessionId = session.data?.id;
      expect(sessionId).toBeTruthy();
      if (!sessionId) {
        throw new Error(`Failed to create session: ${JSON.stringify(session)}`);
      }

      const v2Client = createOpencodeClientV2({
        baseUrl: url,
        directory: tmpDir,
      });

      const promptPromise = client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{
            type: 'text',
            text: 'Edit hello.txt by appending exactly one line: integration permission check via list. Then briefly report what you changed.',
          }],
        },
        query: { directory: tmpDir },
      });

      const pendingPermission = await waitForV2PendingPermission(v2Client, tmpDir, 30000);
      expect(pendingPermission).toBeTruthy();
      if (!pendingPermission) {
        throw new Error('No pending permission request observed via v2 permission.list()');
      }

      expect(pendingPermission.sessionID).toBe(sessionId);
      expect(pendingPermission.permission).toBe('edit');

      await v2Client.permission.reply({
        requestID: pendingPermission.id,
        directory: tmpDir,
        reply: 'once',
      });

      await Promise.race([
        promptPromise,
        sleep(30000).then(() => {
          throw new Error('Timed out waiting for prompt completion after v2 permission.reply()');
        }),
      ]);
    } finally {
      await manager.stop();
    }
  }, 120000);

  it('can complete an edit with a pure v2 config/prompt/permission flow', async () => {
    const manager = new OpenCodeServerManager();
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-permission-v2-pure-'));
    const helloFile = path.join(tmpDir, 'hello.txt');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(helloFile, 'hello\n', 'utf8');

    try {
      const url = await manager.start(tmpDir);
      const v2Client = createOpencodeClientV2({
        baseUrl: url,
        directory: tmpDir,
      });

      await v2Client.config.update({
        directory: tmpDir,
        config: {
          permission: {
            edit: 'ask',
          },
        },
      });

      const session = await v2Client.session.create({ directory: tmpDir });
      const sessionId = session.data?.id;
      expect(sessionId).toBeTruthy();
      if (!sessionId) {
        throw new Error(`Failed to create v2 session: ${JSON.stringify(session)}`);
      }

      const promptPromise = v2Client.session.prompt({
        sessionID: sessionId,
        directory: tmpDir,
        parts: [{
          type: 'text',
          text: 'Edit hello.txt by appending exactly one line: pure v2 permission flow. Then briefly report what you changed.',
        }],
      });

      const pendingPermission = await waitForV2PendingPermission(v2Client, tmpDir, 30000);
      expect(pendingPermission).toBeTruthy();
      if (!pendingPermission) {
        throw new Error('No pending permission request observed via pure v2 permission.list()');
      }

      expect(pendingPermission.sessionID).toBe(sessionId);
      expect(pendingPermission.permission).toBe('edit');

      await v2Client.permission.reply({
        requestID: pendingPermission.id,
        directory: tmpDir,
        reply: 'once',
      });

      await promptPromise;

      const idle = await Promise.race([
        waitForV2SessionIdle(v2Client, tmpDir, sessionId, 30000),
        sleep(30000).then(() => false),
      ]);
      expect(idle).toBe(true);
    } finally {
      await manager.stop();
    }
  }, 120000);
});
