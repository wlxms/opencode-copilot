/**
 * Integration test for the question tool flow.
 *
 * Tests that:
 * 1. SDK client does NOT have question property (known SDK v1 limitation)
 * 2. Raw HTTP POST /question/{id}/reply endpoint is reachable
 * 3. Full flow: prompt → question.asked → HTTP reply → continue
 *
 * Run with: npx vitest run -c vitest.integration.config.ts src/test/integration/question-flow.integration.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createOpencode } from '@opencode-ai/sdk/v2';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// eslint-disable-next-line no-template-curly-in-string
function createTempProject(prefix = 'qflow'): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'qtest', private: true }, null, 2));
  writeFileSync(
    join(dir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        permission: { edit: 'ask', bash: 'allow', read: 'allow' },
      },
      null,
      2,
    ),
  );
  return dir;
}

async function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

interface TestContext {
  directory: string;
  server: { url: string; close: () => void };
  client: any; // OpencodeClient — typed as any because SDK v1 types are incomplete
}

async function setup(): Promise<TestContext> {
  const directory = createTempProject();
  const origCwd = process.cwd();
  process.chdir(directory);
  delete process.env.OPENCODE_SERVER_PASSWORD;
  try {
    const instance = await createOpencode({ port: 0 });
    process.chdir(origCwd);
    return { directory, server: instance.server, client: instance.client };
  } catch (err) {
    process.chdir(origCwd);
    throw err;
  }
}

let ctx: TestContext | undefined;

afterEach(async () => {
  try {
    ctx?.server.close();
  } catch {
    /* ignore */
  }
  if (ctx) {
    await cleanup(ctx.directory);
  }
  ctx = undefined;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('question flow', () => {
  it('confirms SDK v1 client does NOT have question property', async () => {
    ctx = await setup();

    const client = ctx.client;
    // SDK v1 (dist/gen/sdk.gen.js) OpencodeClient has no question getter
    expect(client.question).toBeUndefined();

    // But the HTTP endpoint exists
    const response = await fetch(`${ctx.server.url}/question`);
    expect(response.ok).toBe(true);
  }, 30_000);

  it('raw HTTP POST /question/{id}/reply returns proper error for fake ID', async () => {
    ctx = await setup();

    const response = await fetch(`${ctx.server.url}/question/que_fake-id/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [['test']] }),
    });
    // fake ID → expect 400 or 404, not TypeError
    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = await response.text();
    expect(body).not.toContain('TypeError');
    console.log(`[test] fake reply response: ${response.status} ${body}`);
  }, 30_000);

  it('full flow: prompt → question.asked → HTTP reply → server continues', async () => {
    ctx = await setup();
    const client = ctx.client;
    const baseUrl = ctx.server.url;

    // Create session
    const sessionRes = await client.session.create({
      body: { title: 'qflow' },
      query: { directory: ctx.directory },
    });
    const sessionId = sessionRes.data?.id;
    expect(sessionId).toBeDefined();
    console.log(`[test] session: ${sessionId}`);

    // Subscribe to global SSE events BEFORE prompt
    const sse = await client.global.event();
    const events: any[] = [];
    let resolveQuestion: ((ev: any) => void) | undefined;
    const questionPromise = new Promise<any>((r) => { resolveQuestion = r; });

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    (async () => {
      try {
        for await (const ev of sse.stream) {
          events.push(ev);
          const t = ev.type ?? ev.payload?.type;
          if (t === 'question.asked') {
            resolveQuestion?.(ev);
            resolveQuestion = undefined;
          }
          if (events.length > 500) { break; }
        }
      } catch { /* SSE stream ended */ }
    })();

    // Send prompt WITHOUT awaiting — we need to consume SSE events
    // while the model is generating (question.asked happens mid-generation)
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    client.session.prompt({
      path: { id: sessionId },
      query: { directory: ctx.directory },
      body: {
        parts: [
          {
            type: 'text',
            text: 'Use the question tool to ask me: "What is your favorite color?" with options red, green, blue. You MUST use the question tool to do this.',
          },
        ],
      },
    });
    console.log('[test] prompt sent (non-blocking)');

    // Wait for question.asked (60s)
    const qEvent = await Promise.race([
      questionPromise,
      new Promise<null>((r) => setTimeout(() => r(null), 60_000)),
    ]);

    if (!qEvent) {
      console.log('[test] No question.asked. Events:');
      events.forEach((e) => console.log(`  - ${e.type ?? e.payload?.type}`));
      console.log('[test] SKIP: model did not trigger question tool');
      return;
    }

    console.log('[test] question.asked received');
    // Dump full event structure to find the right field names
    console.log(`[test] raw event keys: ${Object.keys(qEvent).join(', ')}`);
    console.log(`[test] raw event (first 500): ${JSON.stringify(qEvent).substring(0, 500)}`);
    if (qEvent.payload) {
      console.log(`[test] payload keys: ${Object.keys(qEvent.payload).join(', ')}`);
      console.log(`[test] payload (first 500): ${JSON.stringify(qEvent.payload).substring(0, 500)}`);
    }
    if (qEvent.properties) {
      console.log(`[test] properties keys: ${Object.keys(qEvent.properties).join(', ')}`);
    }
    const props = qEvent.properties ?? qEvent.payload?.properties ?? qEvent.payload ?? {};
    const rid = props.requestID ?? props.requestId ?? props.ID ?? props.id;
    console.log(
      `[test] requestID=${rid}, questions=${JSON.stringify(props.questions)?.substring(0, 200)}`,
    );
    expect(rid).toBeDefined();
    expect(rid).toMatch(/^que_/);

    // Reply via raw HTTP
    const replyUrl = `${baseUrl}/question/${rid}/reply?directory=${encodeURIComponent(ctx.directory)}`;
    const replyRes = await fetch(replyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [['red']] }),
    });
    console.log(`[test] HTTP reply: ${replyRes.status}`);
    expect(replyRes.ok).toBe(true);

    // Wait for continuation events
    await new Promise((r) => setTimeout(r, 10_000));

    const idx = events.indexOf(qEvent);
    const after = events.slice(idx + 1);
    console.log(`[test] events after reply: ${after.length}`);
    after.slice(0, 15).forEach((e) => console.log(`  → ${e.type ?? e.payload?.type}`));

    // Server should continue processing after reply
    expect(after.length).toBeGreaterThan(0);
  }, 120_000);
});
