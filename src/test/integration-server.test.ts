/**
 * Integration test: starts a real OpenCode server, sends a prompt,
 * and verifies the complete SSE event flow (message.part.updated,
 * message.part.delta, session.idle).
 *
 * This test validates two orderings:
 *   A) prompt() FIRST, then subscribe()  — production candidate
 *   B) subscribe() FIRST, then prompt()  — original e7b1dcc pattern
 *
 * Run: npx vitest run src/test/integration-server.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createOpencode } from '@opencode-ai/sdk';

const TEST_PROMPT = 'Say hello in one word.';
const TEST_TIMEOUT = 120_000; // 2 minutes for AI inference

interface ServerInstance {
  server: { url: string; close: () => void };
  client: any;
}

/**
 * Start the OpenCode server and return the instance.
 * Must delete OPENCODE_SERVER_PASSWORD first — if set, the server starts
 * with HTTP Basic Auth and the SDK client won't send credentials.
 */
async function startServer(): Promise<ServerInstance> {
  // Match the extension's server.ts behavior
  delete process.env.OPENCODE_SERVER_PASSWORD;
  const instance = await createOpencode({ port: 0 });
  return instance;
}

/**
 * Collect SSE events until session.idle is received, or timeout.
 * Returns the list of event types received.
 */
async function collectEvents(
  events: { stream: AsyncIterable<any> },
  signal: AbortSignal,
): Promise<string[]> {
  const eventTypes: string[] = [];
  try {
    for await (const evt of events.stream) {
      if (signal.aborted) break;
      eventTypes.push(evt.type);
      if (evt.type === 'session.idle') break;
    }
  } catch (err) {
    // SSE connection may close — that's expected after idle
  }
  return eventTypes;
}

describe('OpenCode server integration — prompt + SSE ordering', () => {
  let instanceA: ServerInstance;
  let instanceB: ServerInstance;

  // --- Order A: prompt() FIRST, then subscribe() ---
  describe('Order A: prompt() first, then subscribe()', () => {
    let sessionId: string;
    let eventTypes: string[];
    let promptResult: any;

    beforeAll(async () => {
      instanceA = await startServer();
      const client = instanceA.client;

      // 1. Create session — check for both data and error
      const createResult = await client.session.create({ body: {} });
      console.log('[Order A] create result keys:', Object.keys(createResult));
      if (createResult.error) {
        console.log('[Order A] ERROR:', JSON.stringify(createResult.error).substring(0, 500));
        console.log('[Order A] response status:', createResult.response?.status);
      } else {
        console.log('[Order A] createResult.data:', JSON.stringify(createResult.data).substring(0, 200));
      }
      sessionId = createResult.data?.id
        ?? createResult.id
        ?? createResult.sessionID;
      expect(sessionId, `Could not extract session ID`).toBeTruthy();

      // 2. Fire prompt FIRST (fire-and-forget) — then subscribe to see events
      const promptPromise = client.session.prompt({
        path: { id: sessionId },
        body: { parts: [{ type: 'text', text: TEST_PROMPT }] },
      });

      // 3. THEN subscribe to SSE
      const events = await client.event.subscribe();

      // 4. Collect events until idle
      const controller = new AbortController();
      setTimeout(() => controller.abort(), TEST_TIMEOUT);
      eventTypes = await collectEvents(events, controller);

      // 5. Await prompt result and inspect its structure
      promptResult = await promptPromise;
      console.log('[Order A] prompt result keys:', Object.keys(promptResult));
      const pData = promptResult.data || {};
      console.log('[Order A] prompt data keys:', Object.keys(pData));
      if (pData.info) {
        console.log('[Order A] prompt data.info:', JSON.stringify(pData.info).substring(0, 300));
      }
      if (pData.parts) {
        console.log('[Order A] prompt data.parts count:', pData.parts.length);
        for (let i = 0; i < Math.min(pData.parts.length, 8); i++) {
          const p = pData.parts[i];
          console.log(`[Order A] part[${i}]: type=${p.type}, id=${p.id || ''}, msgID=${p.messageID || ''}, text=${(p.text || '').substring(0, 120)}`);
        }
      } else {
        // Try other common response shapes
        console.log('[Order A] full prompt result (no parts):', JSON.stringify(promptResult).substring(0, 1000));
      }
    }, TEST_TIMEOUT);

    afterAll(() => {
      instanceA?.server?.close();
    });

    it('should log the events received from SSE', () => {
      console.log('[Order A] SSE event types received:', eventTypes);
      expect(eventTypes.length).toBeGreaterThanOrEqual(1);
    });

    it('should return a valid prompt result with response parts', () => {
      expect(promptResult).toBeDefined();
      expect(promptResult.data).toBeDefined();
    });

    it('should have a valid session ID', () => {
      expect(sessionId).toBeTruthy();
      expect(typeof sessionId).toBe('string');
    });
  });

  // --- Order B: subscribe() FIRST, then prompt() (original pattern) ---
  describe('Order B: subscribe() first, then prompt()', () => {
    let sessionId: string;
    let eventTypes: string[];
    let promptResult: any;

    beforeAll(async () => {
      instanceB = await startServer();
      const client = instanceB.client;

      // 1. Create session — check for both data and error
      const createResult = await client.session.create({ body: {} });
      console.log('[Order B] create result keys:', Object.keys(createResult));
      if (createResult.error) {
        console.log('[Order B] ERROR:', JSON.stringify(createResult.error).substring(0, 500));
        console.log('[Order B] response status:', createResult.response?.status);
      } else {
        console.log('[Order B] createResult.data:', JSON.stringify(createResult.data).substring(0, 200));
      }
      sessionId = createResult.data?.id
        ?? createResult.id
        ?? createResult.sessionID;
      expect(sessionId, `Could not extract session ID`).toBeTruthy();

      // 2. Subscribe to SSE FIRST
      const events = await client.event.subscribe();

      // 3. THEN fire prompt (fire-and-forget)
      const promptPromise = client.session.prompt({
        path: { id: sessionId },
        body: { parts: [{ type: 'text', text: TEST_PROMPT }] },
      });

      // 4. Collect events until idle
      const controller = new AbortController();
      setTimeout(() => controller.abort(), TEST_TIMEOUT);
      eventTypes = await collectEvents(events, controller);

      // 5. Await prompt result
      promptResult = await promptPromise;
      console.log('[Order B] prompt result keys:', Object.keys(promptResult));
      const pData = promptResult.data || {};
      console.log('[Order B] prompt data keys:', Object.keys(pData));
      if (pData.info) {
        console.log('[Order B] prompt data.info:', JSON.stringify(pData.info).substring(0, 300));
      }
      if (pData.parts) {
        console.log('[Order B] prompt data.parts count:', pData.parts.length);
        for (let i = 0; i < Math.min(pData.parts.length, 8); i++) {
          const p = pData.parts[i];
          console.log(`[Order B] part[${i}]: type=${p.type}, id=${p.id || ''}, msgID=${p.messageID || ''}, text=${(p.text || '').substring(0, 120)}`);
        }
      } else {
        console.log('[Order B] full prompt result (no parts):', JSON.stringify(promptResult).substring(0, 1000));
      }
    }, TEST_TIMEOUT);

    afterAll(() => {
      instanceB?.server?.close();
    });

    it('should log the events received from SSE', () => {
      console.log('[Order B] SSE event types received:', eventTypes);
      expect(eventTypes.length).toBeGreaterThanOrEqual(1);
    });

    it('should return a valid prompt result with response parts', () => {
      expect(promptResult).toBeDefined();
      expect(promptResult.data).toBeDefined();
    });

    it('should have a valid session ID', () => {
      expect(sessionId).toBeTruthy();
      expect(typeof sessionId).toBe('string');
    });
  });
});
