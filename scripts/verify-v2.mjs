/**
 * SDK v2 comprehensive config test.
 * Tests config.update() with various payloads to isolate the 500 cause.
 */
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';

const c = createOpencodeClient({ baseUrl: 'http://127.0.0.1:4096' });

const TESTS = [
  // ── Non-provider updates ──
  {
    label: 'update "model" only (no provider)',
    params: { config: { model: 'deepseek-v4-flash' } },
  },
  {
    label: 'update "small_model" only',
    params: { config: { small_model: 'deepseek-v4-flash' } },
  },
  // ── With directory ──
  {
    label: 'update "model" with directory="."',
    params: { directory: '.', config: { model: 'deepseek-v4-flash' } },
  },
  // ── Provider updates with minimal fields ──
  {
    label: 'add provider (minimal)',
    params: { config: { provider: { 'acp-p1': { api: 'openai-compatible' } } } },
  },
  {
    label: 'add provider with name',
    params: { config: { provider: { 'acp-p2': { api: 'openai-compatible', name: 'P2' } } } },
  },
  {
    label: 'add provider with options+apiKey',
    params: { config: { provider: { 'acp-p3': { api: 'openai-compatible', name: 'P3', options: { apiKey: 'sk-test' } } } } },
  },
  {
    label: 'add provider with models',
    params: { config: { provider: { 'acp-p4': { api: 'openai-compatible', name: 'P4', models: { 'm1': { name: 'M1' } } } } } },
  },
  // ── Global config ──
  {
    label: 'global config: add provider',
    call: async () => c.global.config.update({ config: { provider: { 'acp-g1': { api: 'openai-compatible', name: 'G1' } } } }),
  },
  // ── Auth endpoint (write key directly) ──
  {
    label: 'auth.set (write key via SDK)',
    call: async () => c.auth.set({ providerID: 'acp-auth1', auth: { type: 'api', key: 'sk-test-auth' } }),
  },
];

for (const t of TESTS) {
  try {
    let r;
    if (t.call) {
      r = await t.call();
    } else {
      r = await c.config.update(t.params);
    }
    const ok = !r.error;
    console.log(`${ok ? '✓' : '✗'} ${t.label}: ${ok ? 'OK' : `FAILED (${r.error.data?.message})`}`);
    if (r.error) console.log(`   error: ${JSON.stringify(r.error.data?.ref ?? '')}`);
  } catch (e) {
    console.log(`✗ ${t.label}: THREW ${e.message}`);
  }
}

// Final check: did any provider land?
console.log('\n--- Final config check ---');
const final = await c.config.get({});
console.log('model:', final.data?.model ?? '(none)');
console.log('provider keys:', Object.keys(final.data?.provider ?? {}).join(', ') || '(none)');
