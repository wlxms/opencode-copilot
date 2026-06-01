/**
 * Production-level integration test: investigates whether the OpenCode daemon
 * auto-generates meaningful session titles.
 *
 * Methodology:
 * 1. Start a real OpenCode daemon against a temp project
 * 2. Create a session
 * 3. Subscribe to both per-session AND global event streams
 * 4. Send a prompt designed to elicit a meaningful response
 * 5. After response completes, check MULTIPLE sources for the title:
 *    a. session.updated events (the canonical title broadcast)
 *    b. sessions.get() — the dedicated GET endpoint
 *    c. sessions.list() — the list endpoint (used by sidebar refresh)
 * 6. Also try sessions.update() to verify title mutation works
 *
 * Run: npx vitest run src/test/integration/session-title.integration.test.ts
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  createLiveHarness,
  createTempProject,
  StreamMonitor,
  type LiveOpenCodeHarness,
} from './helpers/live-opencode';
import type { AcpEvent, AcpSessionLifecycleEvent } from '../../acp/types';

let harness: LiveOpenCodeHarness | undefined;

afterEach(async () => {
  if (harness) {
    await harness.dispose();
    harness = undefined;
  }
});

describe('Session Title Investigation (live daemon)', () => {
  it('discovers how the daemon handles session titles — get, list, updated events', async () => {
    // ── 1. Start daemon ───────────────────────────────────────────────
    const projectDir = createTempProject('title-investigation');
    harness = await createLiveHarness(projectDir);
    console.log(`[title-test] Daemon running at ${harness.backend.getUrl()}`);

    // ── 2. Create a session ───────────────────────────────────────────
    const createResult = await harness.backend.sessions.create({
      directory: projectDir,
      // Intentionally DO NOT pass a title — let the daemon decide
    });
    expect(createResult.data?.id).toBeTruthy();
    const sessionId = createResult.data!.id as string;
    console.log(`[title-test] Session created: ${sessionId}`);
    console.log(`[title-test] sessions.create() returned title: ${JSON.stringify(createResult.data?.title)}`);

    // ── 3. Start event monitoring BEFORE prompting ─────────────────────
    await harness.backend.events.ensureStarted();

    // Per-session stream (events scoped to this session)
    const sessionStream = harness.backend.events.openSessionStream(sessionId);
    const sessionMonitor = new StreamMonitor(sessionStream.stream);

    // Also open the global stream to catch any session.updated that might
    // arrive after the session channel is closed
    const globalStream = harness.backend.events.openGlobalStream();
    const globalMonitor = new StreamMonitor(globalStream.stream);

    // ── 4. Send a prompt that should generate a title-worthy response ──
    const prompt = 'Write a TypeScript function that connects to a PostgreSQL database using connection pooling. The function should be called createPool and accept a connection string.';

    console.log(`[title-test] Sending prompt: "${prompt.substring(0, 50)}..."`);
    const promptResult = await harness.backend.sessions.prompt(
      sessionId,
      prompt,
      projectDir,
    );
    console.log(`[title-test] Prompt completed, result keys: ${Object.keys(promptResult).join(', ')}`);

    // ── 5. Wait for session.idle or timeout ────────────────────────────
    const idleEvent = await sessionMonitor.waitForEvent('session.idle', 120_000);
    if (idleEvent) {
      console.log(`[title-test] session.idle received`);
    } else {
      console.log(`[title-test] WARNING: No session.idle within timeout`);
    }

    // Small grace period for late events
    await new Promise((r) => setTimeout(r, 500));

    // ── 6. Collect ALL events for analysis ─────────────────────────────
    const sessionEvents = sessionMonitor.getAllEvents();
    const globalEvents = globalMonitor.getAllEvents();

    const sessionUpdatedEvents = [
      ...sessionEvents.filter((e) => e.type === 'session.updated'),
      ...globalEvents.filter((e) => e.type === 'session.updated'),
    ] as AcpSessionLifecycleEvent[];

    const allSeenTypes = [
      ...new Set([
        ...sessionEvents.map((e) => e.type),
        ...globalEvents.map((e) => e.type),
      ]),
    ];

    console.log(`[title-test] Event types seen: ${allSeenTypes.join(', ')}`);
    console.log(`[title-test] Total events: session=${sessionEvents.length}, global=${globalEvents.length}`);
    console.log(`[title-test] session.updated events: ${sessionUpdatedEvents.length}`);

    for (const evt of sessionUpdatedEvents) {
      console.log(`[title-test] session.updated: sessionId=${evt.sessionId}, title=${JSON.stringify(evt.title)}`);
    }

    // ── 7. Check sessions.get() ────────────────────────────────────────
    const getResult = await harness.backend.sessions.get(sessionId, projectDir);
    console.log(`[title-test] sessions.get() => data.title = ${JSON.stringify(getResult.data?.title)}`);
    console.log(`[title-test] sessions.get() => full data = ${JSON.stringify(getResult.data)}`);

    // ── 8. Check sessions.list() ───────────────────────────────────────
    const listResult = await harness.backend.sessions.list(projectDir);
    console.log(`[title-test] sessions.list() => ${listResult.data?.length ?? 0} sessions`);
    if (listResult.data) {
      for (const s of listResult.data) {
        console.log(`[title-test]   list entry: id=${s.id}, title=${JSON.stringify(s.title)}`);
      }
    }

    // ── 9. Try sessions.update() to see if mutation works ──────────────
    const testTitle = 'Custom Title - PostgreSQL Connection Pool';
    const updateResult = await harness.backend.sessions.update(sessionId, {
      title: testTitle,
      directory: projectDir,
    });
    console.log(`[title-test] sessions.update("${testTitle}") => data.title = ${JSON.stringify(updateResult.data?.title)}`);

    // Verify the update persisted
    const getAfterUpdate = await harness.backend.sessions.get(sessionId, projectDir);
    console.log(`[title-test] sessions.get() after update => data.title = ${JSON.stringify(getAfterUpdate.data?.title)}`);

    // Verify list after update
    const listAfterUpdate = await harness.backend.sessions.list(projectDir);
    if (listAfterUpdate.data) {
      for (const s of listAfterUpdate.data) {
        console.log(`[title-test]   list after update: id=${s.id}, title=${JSON.stringify(s.title)}`);
      }
    }

    // ── 10. EVIDENCE SUMMARY ──────────────────────────────────────────
    const evidence = {
      sessionId,
      createTitle: createResult.data?.title ?? null,
      sessionUpdatedTitles: sessionUpdatedEvents.map((e) => e.title),
      getTitle: getResult.data?.title ?? null,
      listTitles: listResult.data?.map((s) => ({ id: s.id, title: s.title })) ?? [],
      updateConfirmed: getAfterUpdate.data?.title === testTitle,
      listAfterUpdateTitles: listAfterUpdate.data?.map((s) => ({ id: s.id, title: s.title })) ?? [],
      daemonUrl: harness.backend.getUrl(),
    };

    console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
    console.log(`║  TITLE INVESTIGATION RESULTS                                  ║`);
    console.log(`╠══════════════════════════════════════════════════════════════╣`);
    console.log(`║  Daemon URL:      ${evidence.daemonUrl}`);
    console.log(`║  Session ID:      ${evidence.sessionId}`);
    console.log(`║  Create title:    ${JSON.stringify(evidence.createTitle)}`);
    console.log(`║  Updated events:  ${JSON.stringify(evidence.sessionUpdatedTitles)}`);
    console.log(`║  GET title:       ${JSON.stringify(evidence.getTitle)}`);
    console.log(`║  LIST titles:     ${JSON.stringify(evidence.listTitles)}`);
    console.log(`║  UPDATE works?:   ${evidence.updateConfirmed}`);
    console.log(`║  LIST after upd:  ${JSON.stringify(evidence.listAfterUpdateTitles)}`);
    console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

    // ── 11. Assertions ─────────────────────────────────────────────────
    // Verify session was created
    expect(sessionId).toBeTruthy();

    // sessions.update() should work and be immediately reflected in get()
    expect(evidence.updateConfirmed).toBe(true);
  }, 180_000); // 3 minute timeout for real LLM call
});
