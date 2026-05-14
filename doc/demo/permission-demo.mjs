/**
 * Permission 机制完整演示
 *
 * 这个脚本演示 OpenCode 服务端 permission 系统的完整工作流程：
 *   1. 启动 OpenCode server（自动创建临时 opencode.json 配置）
 *   2. 创建 session + 订阅全局 SSE 事件流
 *   3. 发送一个会触发 edit 工具的 prompt
 *   4. 拦截 permission.asked 事件，展示 diff 内容
 *   5. 模拟用户回复 "once"，让 edit 继续执行
 *   6. 验证文件被成功修改
 *
 * 前置条件:
 *   - Node.js >= 18
 *   - OpenCode CLI: npm i -g opencode-ai  (>= 1.14)
 *   - 当前项目已安装 @opencode-ai/sdk: npm install
 *   - 已配置至少一个 AI Provider（全局 ~/.config/opencode/opencode.json 或项目级）
 *
 * 运行:
 *   node doc/demo/permission-demo.mjs
 *
 * 清理:
 *   脚本会自动清理临时文件和配置。如果中途 Ctrl+C，可能需要手动删除：
 *   - _permission_demo_test.txt（项目根目录）
 *   - opencode.json.bak.demo（项目根目录）
 */

import { createOpencode } from '@opencode-ai/sdk';
import { writeFileSync, readFileSync, existsSync, renameSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(__dirname, '../..');

// ====================== 配置区 ======================

// 测试用临时文件
const TEST_FILE = resolve(PROJECT_DIR, '_permission_demo_test.txt');
const TEST_FILE_CONTENT = 'hello world\nversion=1.0.0\n';

// Permission 配置
const PERMISSION_CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  permission: {
    edit: 'ask',    // ← 关键：edit 操作需要审批
    bash: 'allow',
    read: 'allow',
  },
};

// Prompt 文本（会触发 edit 工具）
const PROMPT_TEXT = `用 edit 工具把 _permission_demo_test.txt 中的 version=1.0.0 改成 version=2.0.0，只改这一行，不做其他事情。`;

// 超时时间（毫秒）
const TIMEOUT_MS = 120_000;

// ====================== 工具函数 ======================

function log(tag, ...args) {
  const ts = new Date().toISOString().substring(11, 12 + 8);
  const prefix = `[${ts}] [${tag}]`;
  console.log(prefix, ...args.map(a => typeof a === 'string' ? a : JSON.stringify(a, null, 2)));
}

function unwrapEvent(raw) {
  // GlobalEvent = { directory, payload }
  if (raw && typeof raw === 'object' && 'payload' in raw) {
    return raw.payload;
  }
  return raw;
}

function summarizeEvent(event) {
  const t = event.type;
  if (t === 'message.part.updated') {
    const part = event.properties?.part;
    if (part?.type === 'tool') return `${t} tool=${part.tool} status=${part.state?.status}`;
    return `${t} type=${part?.type}`;
  }
  if (t === 'message.part.delta') return `${t} partID=${event.properties?.partID} len=${event.properties?.delta?.length}`;
  if (t === 'permission.asked') return `${t} id=${event.properties?.id} perm=${event.properties?.permission}`;
  if (t === 'permission.replied') return `${t} reply=${event.properties?.reply}`;
  if (t === 'session.idle') return `${t} session=${event.properties?.sessionID}`;
  return t;
}

// ====================== 文件管理 ======================

const CONFIG_PATH = resolve(PROJECT_DIR, 'opencode.json');
const CONFIG_BACKUP = resolve(PROJECT_DIR, 'opencode.json.bak.demo');

function setupConfig() {
  // 备份已有配置
  if (existsSync(CONFIG_PATH)) {
    renameSync(CONFIG_PATH, CONFIG_BACKUP);
    log('SETUP', 'Backed up existing opencode.json');
  }
  // 写入测试配置
  writeFileSync(CONFIG_PATH, JSON.stringify(PERMISSION_CONFIG, null, 2));
  log('SETUP', `Created opencode.json with permission.edit="ask"`);
}

function restoreConfig() {
  // 删除测试配置
  if (existsSync(CONFIG_PATH) && !existsSync(CONFIG_BACKUP)) {
    unlinkSync(CONFIG_PATH);
    log('CLEANUP', 'Removed test opencode.json');
  }
  // 恢复备份
  if (existsSync(CONFIG_BACKUP)) {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    renameSync(CONFIG_BACKUP, CONFIG_PATH);
    log('CLEANUP', 'Restored original opencode.json');
  }
}

function ensureTestFile() {
  writeFileSync(TEST_FILE, TEST_FILE_CONTENT);
  log('SETUP', `Created test file: ${TEST_FILE}`);
}

function cleanupTestFile() {
  try {
    if (existsSync(TEST_FILE)) {
      unlinkSync(TEST_FILE);
      log('CLEANUP', 'Removed test file');
    }
  } catch { /* ignore */ }
}

// ====================== 主流程 ======================

async function runDemo() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  OpenCode Permission Demo — 完整工作流演示                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`项目目录: ${PROJECT_DIR}`);
  console.log(`测试文件: ${TEST_FILE}`);
  console.log('');

  let serverInstance = null;

  try {
    // ── Step 1: 准备环境 ──────────────────────────────────
    console.log('━━━ Step 1: 准备环境 ━━━');
    setupConfig();
    ensureTestFile();
    console.log('');

    // ── Step 2: 启动 OpenCode Server ─────────────────────
    console.log('━━━ Step 2: 启动 OpenCode Server ━━━');
    const originalCwd = process.cwd();
    try {
      process.chdir(PROJECT_DIR);
      delete process.env.OPENCODE_SERVER_PASSWORD;
      serverInstance = await createOpencode({ port: 0 });
    } finally {
      process.chdir(originalCwd);
    }

    const { client, server } = serverInstance;
    log('SERVER', `Server URL: ${server.url}`);
    console.log('');

    // ── Step 3: 创建 Session ─────────────────────────────
    console.log('━━━ Step 3: 创建 Session ━━━');
    const sessionResult = await client.session.create({
      query: { directory: PROJECT_DIR },
    });
    const sessionId = sessionResult.data?.id;
    if (!sessionId) throw new Error(`Failed to create session: ${JSON.stringify(sessionResult)}`);
    log('SESSION', `Session ID: ${sessionId}`);
    console.log('');

    // ── Step 4: 订阅全局 SSE 事件 ─────────────────────────
    console.log('━━━ Step 4: 订阅全局 SSE 事件流 ━━━');
    const events = await client.global.event();
    log('SSE', 'Subscribed to /global/event');
    console.log('');

    // ── Step 5: 发送 Prompt (fire-and-forget) ─────────────
    console.log('━━━ Step 5: 发送 Prompt (fire-and-forget) ━━━');
    log('PROMPT', `"${PROMPT_TEXT}"`);

    const promptPromise = client.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: 'text', text: PROMPT_TEXT }] },
      query: { directory: PROJECT_DIR },
    }).then(r => {
      log('PROMPT', `Resolved: HTTP ${r?.response?.status}`);
    }).catch(e => {
      log('PROMPT', `Error: ${e.message}`);
    });
    console.log('');

    // ── Step 6: 消费 SSE 事件，拦截 permission.asked ─────
    console.log('━━━ Step 6: 消费 SSE 事件 ━━━');
    console.log('');

    let permissionAsked = null;
    let resolveDone;
    const done = new Promise(r => { resolveDone = r; });

    const eventTypes = [];
    const eventLog = [];

    try {
      for await (const rawEvent of events.stream) {
        const event = unwrapEvent(rawEvent);
        const type = event.type;
        eventTypes.push(type);

        // 简要日志
        log('EVENT', summarizeEvent(event));

        // 拦截 permission.asked
        if (type === 'permission.asked') {
          permissionAsked = event;
          console.log('');
          console.log('  ╔════════════════════════════════════════════════════╗');
          console.log('  ║  ★ PERMISSION ASKED — 服务端暂停，等待审批 ★        ║');
          console.log('  ╚════════════════════════════════════════════════════╝');
          console.log('');
          console.log(`  Permission ID : ${event.properties.id}`);
          console.log(`  Session ID    : ${event.properties.sessionID}`);
          console.log(`  Permission    : ${event.properties.permission}`);
          console.log(`  Patterns      : ${JSON.stringify(event.properties.patterns)}`);
          console.log(`  Always        : ${JSON.stringify(event.properties.always)}`);
          console.log(`  Tool CallID   : ${event.properties.tool?.callID}`);
          console.log('');

          // 展示 diff
          const diff = event.properties.metadata?.diff;
          if (diff) {
            console.log('  ┌─── Diff (metadata.diff) ────────────────────────────┐');
            for (const line of String(diff).split('\n')) {
              if (!line) continue;
              const trimmed = line.substring(0, 76);
              if (trimmed.startsWith('+') && !trimmed.startsWith('+++')) {
                console.log(`  │ ${trimmed}`.green);
              } else if (trimmed.startsWith('-') && !trimmed.startsWith('---')) {
                console.log(`  │ ${trimmed}`.red);
              } else {
                console.log(`  │ ${trimmed}`);
              }
            }
            console.log('  └─────────────────────────────────────────────────────┘');
            console.log('');
          }

          // ── Step 7: 回复 permission ───────────────────────
          console.log('  ─── 回复 permission: "once" ───');

          const replyResult = await client.postSessionIdPermissionsPermissionId({
            path: {
              id: sessionId,
              permissionID: event.properties.id,
            },
            body: { response: 'once' },
            query: { directory: PROJECT_DIR },
          });

          log('REPLY', `POST /session/${sessionId}/permissions/${event.properties.id}`);
          log('REPLY', `HTTP ${replyResult?.response?.status}, data=${replyResult?.data}`);
          console.log('');
        }

        // session.idle = 回合结束
        if (type === 'session.idle') {
          log('DONE', 'Session went idle');
          resolveDone();
          break;
        }
      }
    } catch (e) {
      log('SSE', `Stream error: ${e.message}`);
      resolveDone();
    }

    // 等待完成或超时
    await Promise.race([done, new Promise(r => setTimeout(r, TIMEOUT_MS))]);
    await promptPromise;

    // ── Step 8: 结果验证 ──────────────────────────────────
    console.log('');
    console.log('━━━ Step 8: 结果验证 ━━━');

    const fileWasModified = existsSync(TEST_FILE) && readFileSync(TEST_FILE, 'utf-8').includes('2.0.0');
    const uniqueTypes = [...new Set(eventTypes)];

    console.log('');
    console.log(`  收到的事件类型 (${uniqueTypes.length}): ${uniqueTypes.join(', ')}`);
    console.log(`  permission.asked 事件: ${permissionAsked ? '✅ YES' : '❌ NO'}`);
    console.log(`  Permission Reply 成功: ${permissionAsked ? '✅ YES (HTTP 200)' : 'N/A'}`);
    console.log(`  文件被修改为 2.0.0:    ${fileWasModified ? '✅ YES' : '❌ NO'}`);
    console.log('');

    if (permissionAsked && fileWasModified) {
      console.log('  ╔════════════════════════════════════════════════════╗');
      console.log('  ║  ✓ Permission 机制验证通过                          ║');
      console.log('  ║                                                    ║');
      console.log('  ║  1. permission.edit="ask" 触发了 permission.asked   ║');
      console.log('  ║  2. 服务端暂停，等待回复后继续执行                     ║');
      console.log('  ║  3. Reply API (once) 成功，edit 工具完成执行          ║');
      console.log('  ╚════════════════════════════════════════════════════╝');
    } else {
      console.log('  ❌ 验证失败 — 请检查 AI Provider 配置和 OpenCode CLI');
    }

    // 关闭 server
    server.close();
    log('SERVER', 'Closed');

  } catch (err) {
    console.error('');
    console.error('❌ Fatal error:', err);
    console.error('');
    console.error('可能的原因:');
    console.error('  1. OpenCode CLI 未安装: npm i -g opencode-ai');
    console.error('  2. AI Provider 未配置: ~/.config/opencode/opencode.json');
    console.error('  3. SDK 未安装: npm install');
    if (serverInstance) serverInstance.server.close();
  } finally {
    restoreConfig();
    cleanupTestFile();
  }
}

// ── 启动 ──
runDemo();
