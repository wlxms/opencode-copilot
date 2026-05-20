import * as vscode from 'vscode';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { execSync, exec } from 'child_process';
import type { Model, Provider } from '@opencode-ai/sdk';
import type { ExtensionState } from '../types';
import { ErrorMessages } from './errors';
import { ensureServer } from './handler';
import { ExternalEditTracker } from './external-edit-tracker';

export async function routeCommand(
  command: string,
  state: ExtensionState,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  switch (command.toLowerCase()) {
    case 'new':
      await handleNewCommand(state, stream);
      break;
    case 'help':
      handleHelpCommand(stream);
      break;
    case 'model':
      await handleModelCommand(state, stream);
      break;
    case 'test-external-edit':
      await handleTestExternalEditCommand(state, stream, _token);
      break;
    case 'test-external-edit-real':
      await handleTestExternalEditRealCommand(state, stream, _token);
      break;
    case 'test-external-edit-e2e':
      await handleTestExternalEditE2ECommand(state, stream, _token);
      break;
    default:
      stream.markdown(
        `⚠️ Unknown command '/${command}'. Use **/help** to see available commands.`,
      );
  }
  return { metadata: {} };
}

async function handleNewCommand(
  state: ExtensionState,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const client = await ensureServer(state, stream);
  if (!client) return;
  try {
    const result = await client.session.create({ body: {} });
    const sessionId = result.data?.id;
    if (!sessionId) {
      throw new Error('Session not created');
    }
    state.activeSessionId = sessionId;
    stream.markdown('🆕 Started a new conversation session.');
    state.outputChannel.appendLine(`[commands] New session: ${sessionId}`);
  } catch {
    stream.markdown(ErrorMessages.SESSION_ERROR);
  }
}

function handleHelpCommand(stream: vscode.ChatResponseStream): void {
  stream.markdown(
    [
      '## Available Commands',
      '',
      '- **/new** — Start a new conversation session',
      '- **/help** — Show this help message',
      '- **/model** — Show the current active model',
      '- **/test-external-edit** — Test externalEdit bubble push (VSCode API)',
      '- **/test-external-edit-real** — Test externalEdit with direct disk write (simulates server)',
      '- **/test-external-edit-e2e** — End-to-end test via real OpenCode prompt',
      '',
      'Just type your message to chat with OpenCode!',
    ].join('\n'),
  );
}

async function handleModelCommand(
  state: ExtensionState,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const client = await ensureServer(state, stream);
  if (!client) return;
  try {
    const providersResp = await client.config.providers();
    const providerList: Provider[] = providersResp.data?.providers ?? [];
    if (providerList.length > 0) {
      const lines: string[] = ['## Available Models', ''];
      for (const p of providerList) {
        const models: Model[] = Object.values(p.models ?? {});
        const active = models.filter((model) => model.status === 'active');
        if (active.length > 0) {
          lines.push(`**${p.name}** (${p.id}):`);
          for (const m of active) {
            lines.push(`  - \`${m.id}\` — ${m.name}`);
          }
        }
      }
      stream.markdown(lines.join('\n'));
    } else {
      stream.markdown('No providers configured.');
    }
  } catch {
    stream.markdown('Unable to retrieve model information.');
  }
}

/**
 * Test command: simulates an externalEdit lifecycle to verify bubble pushing.
 *
 * Creates a temporary file, pushes a ChatResponseExternalEditPart (bubble),
 * writes content to the file (simulating an external edit), then completes
 * the edit. Cleans up the temp file afterwards.
 */
async function handleTestExternalEditCommand(
  state: ExtensionState,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) {
    stream.markdown('⚠️ No workspace folder open. Open a folder and try again.');
    return;
  }

  const tracker = new ExternalEditTracker();
  const editKey = `test-${Date.now()}`;
  const tmpPath = vscode.Uri.joinPath(
    workspaceFolders[0].uri,
    `.opencode-external-edit-test-${Date.now()}.tmp`,
  );

  stream.markdown(`🧪 **Testing externalEdit bubble push...**\n\n`);
  stream.markdown(`Temporary file: \`${tmpPath.fsPath}\`\n\n`);

  try {
    // 1. Create the temp file so it exists on disk (baseline capture needs this)
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(tmpPath, encoder.encode('// original content\n'));

    // 2. Push the externalEdit bubble
    stream.markdown('📤 Pushing `ChatResponseExternalEditPart` bubble...\n\n');

    const trackPromise = tracker.trackEdit(editKey, [tmpPath], stream, token);
    await trackPromise;

    stream.markdown('✅ `trackEdit` resolved — baseline captured by VSCode.\n\n');

    // 3. Simulate an external edit: modify the file content
    stream.markdown('✏️ Simulating external edit (writing new content)...\n\n');
    await vscode.workspace.fs.writeFile(tmpPath, encoder.encode('// modified by externalEdit test\n'));

    // 4. Complete the edit — VSCode will snapshot the diff
    const result = tracker.completeEdit(editKey);
    if (result) {
      const undoStopId = await result;
      stream.markdown(
        `✅ ` +
        `\`completeEdit\` resolved — undoStopId: \`${undoStopId || '(empty)'}\`\n\n`,
      );
    } else {
      stream.markdown('⚠️ `completeEdit` returned undefined — edit may not have been tracked.\n\n');
    }

    stream.markdown(
      '**Result:** externalEdit bubble lifecycle completed successfully. ' +
      'Check the chat UI above for the edit checkpoint bubble.\n',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stream.markdown(`❌ **Error:** ${msg}\n`);
    stream.markdown(
      '\nThe externalEdit API may not be available in this VSCode version. ' +
      'Ensure `chatParticipantAdditions` proposal is enabled.\n',
    );
  } finally {
    // 5. Cleanup temp file
    try {
      await vscode.workspace.fs.delete(tmpPath);
    } catch {
      // best effort
    }
    tracker.dispose();
  }

  state.outputChannel.appendLine('[commands] test-external-edit completed');
}

// ---------------------------------------------------------------------------
// /test-external-edit-real — simulate server-side disk write + timing analysis
// ---------------------------------------------------------------------------

/** Read file content from disk via Node fs (bypasses VSCode entry model) */
function readDiskContent(fsPath: string): string {
  try {
    const { readFileSync } = require('fs') as typeof import('fs');
    return readFileSync(fsPath, 'utf-8');
  } catch {
    return '(read failed)';
  }
}

/** Read file content as VSCode sees it (through text document model) */
function readVscodeModelContent(uri: vscode.Uri): string {
  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === uri.toString(),
  );
  return doc ? doc.getText() : '(not in VSCode model)';
}

/**
 * Wait for VSCode's file watcher to detect a change on disk for the given URI.
 * Returns true if detected within timeout, false otherwise.
 * This is the "sync lock" — ensures VSCode's entry model is up-to-date.
 */
function waitForVscodeFileChange(uri: vscode.Uri, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;

    const done = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sub.dispose();
      resolve(result);
    };

    const timer = setTimeout(() => done(false), timeoutMs);

    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === uri.toString()) {
        done(true);
      }
    });

    // Also watch for file system changes (file may not be open as text doc)
    const fsWatcher = vscode.workspace.createFileSystemWatcher(uri.fsPath);
    fsWatcher.onDidChange(() => done(true));
  });
}

/**
 * Test command: simulates the REAL OpenCode server flow.
 *
 * Key difference from /test-external-edit:
 *   - Uses Node.js `fs.writeFileSync` (direct disk write) instead of
 *     `vscode.workspace.fs.writeFile` (which updates VSCode's entry model
 *     immediately).
 *   - Runs TWO rounds: immediate completeEdit vs delayed completeEdit,
 *     to diagnose whether VSCode's file watcher has time to detect the
 *     external change before diff capture.
 *
 * Usage: @opencode /test-external-edit-real [delay_ms]
 *   delay_ms: milliseconds to wait before completeEdit (default: 0)
 */
async function handleTestExternalEditRealCommand(
  state: ExtensionState,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) {
    stream.markdown('⚠️ No workspace folder open. Open a folder and try again.');
    return;
  }

  // Parse optional delay from... we use a fixed 2-round test
  const ROUND1_LABEL = 'Round 1: fs.writeFileSync + immediate completeEdit';
  const ROUND2_LABEL = 'Round 2: fs.writeFileSync + 500ms delayed completeEdit';
  const ROUND3_LABEL = 'Round 3: powershell write + immediate completeEdit';
  const ROUND4_LABEL = 'Round 4: node child process + immediate completeEdit';
  const ROUND5_LABEL = 'Round 5: async child process + waitForSync completeEdit';

  const tmpDir = workspaceFolders[0].uri;

  // ── Helpers ─────────────────────────────────────────────────────────

  function tmpFileUri(tag: string) {
    return vscode.Uri.joinPath(tmpDir, `.ext-edit-real-${tag}-${Date.now()}.tmp`);
  }

  async function runRound(
    label: string,
    delayMs: number,
    roundStream: vscode.ChatResponseStream,
    writeMethod: 'fs' | 'cmd' | 'powershell' | 'async' = 'fs',
  ): Promise<void> {
    const tracker = new ExternalEditTracker();
    const editKey = `round-${Date.now()}`;
    const tag = `${writeMethod}-d${delayMs}`;
    const uri = tmpFileUri(tag);
    const fsPath = uri.fsPath;
    const original = '// original content\n';
    const methodLabel = writeMethod === 'async' ? 'async child process + waitForSync'
      : writeMethod === 'powershell' ? 'powershell'
      : writeMethod === 'cmd' ? 'node -e (child process)'
      : 'fs.writeFileSync';
    const modified = `// MODIFIED by ${methodLabel}\n`;

    roundStream.markdown(`### ${label}\n\n`);
    roundStream.markdown(`File: \`${fsPath}\`\n\n`);

    try {
      // 1. Create file
      writeFileSync(fsPath, original, 'utf-8');
      roundStream.markdown(`1️⃣ File created on disk: \`${original.trim()}\`\n\n`);
      roundStream.markdown(
        `   VSCode model: \`${readVscodeModelContent(uri).trim()}\`\n\n`,
      );

      // 2. Push externalEdit bubble
      roundStream.markdown('2️⃣ Pushing `ChatResponseExternalEditPart` bubble...\n\n');

      const trackPromise = tracker.trackEdit(editKey, [uri], roundStream, token);
      await trackPromise;
      roundStream.markdown('   ✅ `trackEdit` resolved — baseline captured.\n\n');

      // 3. Modify file — via fs, powershell, cmd child process, or async
      if (writeMethod === 'async') {
        // --- ASYNC FLOW: spawn child process + wait for VSCode sync ---

        // 3a. Set up close listener BEFORE spawning (avoids race condition)
        const b64 = Buffer.from(modified, 'utf-8').toString('base64');
        const escaped = fsPath.replace(/\\/g, '\\\\');
        const child = exec(
          `node -e "require('fs').writeFileSync('${escaped}', Buffer.from('${b64}','base64'))"`,
          { windowsHide: true },
        );
        const childExitPromise = new Promise<void>((resolve) => {
          child.on('close', () => resolve());
          child.on('error', () => resolve());
        });

        roundStream.markdown(
          `3️⃣ Async child process spawned — waiting for VSCode file watcher sync...\n\n`,
        );

        // 3b. Start sync lock: wait for VSCode file watcher OR child exit
        const syncResult = await waitForVscodeFileChange(uri, 2000);
        roundStream.markdown(
          syncResult
            ? `   ✅ VSCode detected file change (sync lock released).\n\n`
            : `   ⚠️ Sync lock timed out after 2000ms — VSCode did not detect change.\n\n`,
        );

        // 3c. Ensure child process has fully exited (listener was attached before spawn)
        await childExitPromise;

        const diskContent = readDiskContent(fsPath);
        const vscodeContent = readVscodeModelContent(uri);
        roundStream.markdown(
          `   Disk:  \`${diskContent.trim()}\`\n` +
          `   Model: \`${vscodeContent.trim()}\`\n\n`,
        );
      } else if (writeMethod === 'powershell') {
        const b64 = Buffer.from(modified, 'utf-8').toString('base64');
        execSync(
          `powershell -NoProfile -Command "[System.IO.File]::WriteAllBytes('${fsPath}', [System.Convert]::FromBase64String('${b64}'))"`,
          { windowsHide: true },
        );
        roundStream.markdown(
          `3️⃣ File modified via \`powershell\`: \`${original.trim()}\` → \`${modified.trim()}\`\n\n`,
        );
      } else if (writeMethod === 'cmd') {
        // Spawn a separate node process to write — simulates server process
        const b64 = Buffer.from(modified, 'utf-8').toString('base64');
        execSync(
          `node -e "require('fs').writeFileSync('${fsPath.replace(/\\/g, '\\\\')}', Buffer.from('${b64}','base64'))"`,
          { windowsHide: true },
        );
        roundStream.markdown(
          `3️⃣ File modified via \`node -e\` (child process): \`${original.trim()}\` → \`${modified.trim()}\`\n\n`,
        );
      } else {
        writeFileSync(fsPath, modified, 'utf-8');
        roundStream.markdown(
          `3️⃣ Direct disk write: \`${original.trim()}\` → \`${modified.trim()}\`\n\n`,
        );
      }

      // Snapshot: what's actually on disk vs what VSCode thinks
      const diskContent = readDiskContent(fsPath);
      const vscodeContent = readVscodeModelContent(uri);
      roundStream.markdown(
        `   Disk content:  \`${diskContent.trim()}\`\n` +
        `   VSCode model:  \`${vscodeContent.trim()}\`\n\n`,
      );

      // 4. Wait the specified delay
      if (delayMs > 0) {
        roundStream.markdown(`4️⃣ Waiting ${delayMs}ms for VSCode file watcher...\n\n`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          token.onCancellationRequested(() => {
            clearTimeout(timer);
            resolve();
          });
        });

        const vscodeAfterWait = readVscodeModelContent(uri);
        roundStream.markdown(
          `   After wait — VSCode model: \`${vscodeAfterWait.trim()}\`\n\n`,
        );
      }

      // 5. Complete the edit
      roundStream.markdown(`5️⃣ Calling \`completeEdit\`...\n\n`);
      const result = tracker.completeEdit(editKey);
      if (result) {
        const t0 = Date.now();
        const undoStopId = await result;
        const elapsed = Date.now() - t0;
        roundStream.markdown(
          `   ✅ \`completeEdit\` resolved in ${elapsed}ms — undoStopId: \`${undoStopId || '(empty)'}\`\n\n`,
        );

        // Final snapshot
        const finalVscode = readVscodeModelContent(uri);
        const finalDisk = readDiskContent(fsPath);
        roundStream.markdown(
          `   Final VSCode model: \`${finalVscode.trim()}\`\n` +
          `   Final disk content: \`${finalDisk.trim()}\`\n\n`,
        );

        if (undoStopId) {
          roundStream.markdown(
            '**✅ VERDICT:** Bubble pushed with undoStopId — VSCode captured the diff.\n\n',
          );
        } else {
          roundStream.markdown(
            '**⚠️ VERDICT:** undoStopId is empty — VSCode may not have captured the diff.\n\n',
          );
        }
      } else {
        roundStream.markdown(
          '   ⚠️ `completeEdit` returned undefined — edit was not tracked.\n\n' +
          '   This likely means `ChatResponseExternalEditPart` is not available.\n\n',
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      roundStream.markdown(`❌ **Error:** ${msg}\n\n`);
    } finally {
      tracker.dispose();
      // NOTE: temp files are intentionally NOT deleted so user can inspect them
    }
  }

  // ── Run both rounds ─────────────────────────────────────────────────

  stream.markdown(
    '🧪 **externalEdit real-flow diagnostic**\n\n' +
    'Comparing write methods and timing.\n\n' +
    '---\n\n',
  );

  await runRound(ROUND1_LABEL, 0, stream, 'fs');

  stream.markdown('---\n\n');

  await runRound(ROUND2_LABEL, 500, stream, 'fs');

  stream.markdown('---\n\n');

  await runRound(ROUND3_LABEL, 0, stream, 'powershell');

  stream.markdown('---\n\n');

  await runRound(ROUND4_LABEL, 0, stream, 'cmd');

  stream.markdown('---\n\n');

  await runRound(ROUND5_LABEL, 0, stream, 'async');

  stream.markdown(
    '---\n\n' +
    '### How to interpret\n\n' +
    '- **Round 5** is the key test: async child process + sync lock.\n' +
    '  If it succeeds → the sync lock pattern works and can be applied to\n' +
    '  the real flow (`streaming.ts` `handleToolState` → wait for file change\n' +
    '  before `completeEdit`).\n\n' +
    '- If **all rounds succeed** → externalEdit works with all write methods.\n\n' +
    '- If **Round 4/5 fail** but **1-3 succeed** → child process writes have issues.\n\n' +
    '- If **all fail** → `ChatResponseExternalEditPart` not available.\n',
  );

  state.outputChannel.appendLine('[commands] test-external-edit-real completed');
}

// ---------------------------------------------------------------------------
// /test-external-edit-e2e — End-to-end test via real OpenCode prompt
// Two modes:
//   @opencode /test-external-edit-e2e         → Mode B: pre-turn monitoring
//   @opencode /test-external-edit-e2e per-edit → Mode A: per-edit tracking
// ---------------------------------------------------------------------------

async function handleTestExternalEditE2ECommand(
  state: ExtensionState,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) {
    stream.markdown('⚠️ No workspace folder open.');
    return;
  }

  // 1. Start server
  stream.markdown('🧪 **E2E Test: real OpenCode prompt → file edit → externalEdit**\n\n');
  stream.markdown('1️⃣ Starting OpenCode server...\n\n');
  const client = await ensureServer(state, stream);
  if (!client) return;
  const directory = workspaceFolders[0].uri.fsPath;

  // 2. Create temp file for the edit target
  const tmpUri = vscode.Uri.joinPath(workspaceFolders[0].uri, `.e2e-edit-target-${Date.now()}.txt`);
  const tmpPath = tmpUri.fsPath;
  const originalContent = 'hello world';
  writeFileSync(tmpPath, originalContent, 'utf-8');
  stream.markdown(`2️⃣ Created test file: \`${tmpPath}\`\n\n`);

  // 3. Create session
  stream.markdown('3️⃣ Creating session...\n\n');
  let sessionId: string;
  try {
    const sessionResp = await client.session.create({
      body: {},
      query: { directory },
    });
    sessionId = sessionResp.data?.id ?? '';
    if (!sessionId) throw new Error('empty session id');
    stream.markdown(`   Session: \`${sessionId}\`\n\n`);
  } catch (err) {
    stream.markdown(`❌ Failed to create session: ${err}\n\n`);
    try { unlinkSync(tmpPath); } catch { /* best effort */ }
    return;
  }

  const tracker = new ExternalEditTracker();
  const editKey = `ask-${Date.now()}`;
  let baselineCaptured = false;
  let editComplete = false;
  let undoStopId = '';

  // 4. Subscribe to SSE + send prompt
  stream.markdown('4️⃣ Subscribing to SSE and sending prompt...\n\n');

  const prompt = `Edit the file ${tmpPath}: replace "hello world" with "hello e2e test". Do not add any other text.`;
  state.outputChannel.appendLine(`[e2e] Prompt: ${prompt}`);

  let eventStream: import('../types/events').OpenCodeEventStream;
  try {
    await state.eventBroker.ensureStarted(client, state.outputChannel);
    eventStream = state.eventBroker.openSessionStream(sessionId);
  } catch (err) {
    stream.markdown(`❌ Failed to subscribe to events: ${err}\n\n`);
    try { unlinkSync(tmpPath); } catch { /* best effort */ }
    tracker.dispose();
    return;
  }

  // Send prompt (fire and don't await)
  const promptPromise = client.session.prompt({
    path: { id: sessionId },
    body: { parts: [{ type: 'text', text: prompt }] },
    query: { directory },
  }).catch((err: unknown) => {
    state.outputChannel.appendLine(`[e2e] Prompt error: ${err}`);
  });

  // 5. Process SSE events
  stream.markdown('5️⃣ Processing SSE event stream...\n\n');
  stream.markdown('```\n');

  let eventCount = 0;
  let permissionAskedCount = 0;
  let toolCompletedCount = 0;
  let editCallID = '';

  try {
    for await (const rawEvt of eventStream.stream) {
      if (token.isCancellationRequested) break;
      const evt = ('payload' in rawEvt) ? rawEvt.payload : rawEvt as import('../types/events').OpenCodeEvent;
      eventCount++;
      const evtType = evt.type;

      if (evtType === 'permission.asked') {
        permissionAskedCount++;
        const props = (evt as import('../types/events').PermissionAskedEvent).properties;
        const callID = props.tool?.callID ?? '';
        const filepath = props.metadata?.filepath ?? '';
        stream.markdown(
          `[${eventCount}] 🔐 permission.asked id=${props.id ?? '?'} ` +
          `callID=${callID || '(empty)'} ` +
          `filepath=${filepath || '(empty)'}\n`,
        );
        // If filepath matches target, parallel trackEdit + "once"
        if (filepath && tmpPath && filepath.toLowerCase() === tmpPath.toLowerCase()) {
          editCallID = callID;
          stream.markdown(`     🎯 Matched target file — parallel trackEdit + "once"\n`);
          await Promise.all([
            tracker.trackEdit(editKey, [tmpUri], stream, token).then(() => {
              baselineCaptured = true;
              stream.markdown(`     ✅ trackEdit resolved — baseline captured\n`);
            }).catch((err: unknown) => {
              stream.markdown(`     ❌ trackEdit error: ${err}\n`);
            }),
            (async () => {
              if (client && props.sessionID && props.id) {
                try {
                  await client.postSessionIdPermissionsPermissionId({
                    path: { id: props.sessionID, permissionID: props.id },
                    body: { response: 'once' },
                    query: { directory },
                  });
                  stream.markdown(`     ✅ Replied "once"\n`);
                } catch (err) {
                  stream.markdown(`     ❌ Reply failed: ${err}\n`);
                }
              }
            })(),
          ]);
        } else if (client && props.sessionID && props.id) {
          // Non-matching filepath — just reply "once"
          try {
            await client.postSessionIdPermissionsPermissionId({
              path: { id: props.sessionID, permissionID: props.id },
              body: { response: 'once' },
              query: { directory },
            });
            stream.markdown(`     ✅ Replied "once"\n`);
          } catch (err) {
            stream.markdown(`     ❌ Reply failed: ${err}\n`);
          }
        }
      } else if (evtType === 'message.part.updated') {
        const part = (evt as any).properties?.part;
        if (part?.type === 'tool' && part?.state?.status === 'completed') {
          toolCompletedCount++;
          const toolCallID = part.callID ?? part.id ?? '';
          stream.markdown(
            `[${eventCount}] 🔧 tool completed: ${part.tool ?? '?'} callID=${toolCallID}\n`,
          );
          // completeEdit when the matched tool finishes
          if (baselineCaptured && !editComplete && editCallID && toolCallID === editCallID) {
            const result = tracker.completeEdit(editKey);
            if (result) {
              undoStopId = (await result) || '';
              editComplete = true;
              stream.markdown(`     ✅ completeEdit at tool.completed — undoStopId: \`${undoStopId || '(empty)'}\`\n`);
            } else {
              stream.markdown(`     ⚠️ completeEdit returned undefined\n`);
            }
          }
        } else if (part?.type === 'tool' && part?.state?.status) {
          stream.markdown(
            `[${eventCount}] 🔧 tool ${part.state.status}: ${part.tool ?? '?'}\n`,
          );
        }
      } else if (evtType === 'session.idle') {
        stream.markdown(`[${eventCount}] ✅ session.idle — turn complete\n`);
        break;
      } else if (evtType === 'session.diff') {
        const diffs = (evt as any).properties?.diff;
        stream.markdown(`[${eventCount}] 📄 session.diff: ${diffs?.length ?? 0} file(s)\n`);
      }
    }
  } catch (err) {
    stream.markdown(`\n❌ Event stream error: ${err}\n`);
  }

  stream.markdown('```\n\n');

  // 6. Summary
  const fileContent = existsSync(tmpPath) ? readDiskContent(tmpPath) : '(file deleted)';
  const fileChanged = fileContent.includes('hello e2e test');

  stream.markdown([
    '---\n\n',
    '### E2E Summary (Ask-time trackEdit + parallel once)\n\n',
    `| Metric | Value |\n`,
    `|---|---|\n`,
    `| Events received | ${eventCount} |\n`,
    `| permission.asked | ${permissionAskedCount} |\n`,
    `| tool completed | ${toolCompletedCount} |\n`,
    `| Baseline captured (at ask) | ${baselineCaptured} |\n`,
    `| completeEdit (at tool.completed) | ${editComplete} |\n`,
    `| undoStopId | \`${undoStopId || '(none)'}\` |\n`,
    `| File changed on disk | ${fileChanged} |\n`,
    `| File content | \`${fileContent.trim()}\` |\n\n`,
  ].join(''));

  if (editComplete && undoStopId) {
    stream.markdown('**✅ Ask-time parallel approach worked!** Check the bubble above for the diff.\n\n');
  } else if (editComplete && !undoStopId) {
    stream.markdown(
      '**⚠️ completeEdit resolved but undoStopId is empty.**\n' +
      'VSCode may not have captured the diff — file watcher latency?\n\n',
    );
  } else if (!baselineCaptured && permissionAskedCount > 0) {
    stream.markdown(
      '**❌ permission.asked received but trackEdit failed.**\n\n',
    );
  } else if (permissionAskedCount === 0) {
    stream.markdown(
      '**⚠️ No `permission.asked` event received.** Check opencode.json `permission.edit` setting.\n\n',
    );
  }

  // Cleanup
  state.eventBroker.closeSessionStream(sessionId);
  try { if (existsSync(tmpPath)) { unlinkSync(tmpPath); } } catch { /* best effort */ }
  tracker.dispose();

  state.outputChannel.appendLine('[commands] test-external-edit-e2e completed');
}



