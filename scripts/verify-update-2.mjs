/**
 * Phase 3: Test config.update() with different parameters.
 */
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';

const c = createOpencodeClient({ baseUrl: 'http://127.0.0.1:4096' });

// Test 1: with directory param
console.log('--- Test A: config.update() WITH directory ---');
try {
  const r = await c.config.update({
    directory: '.',
    config: {
      provider: {
        'acp-test-x': {
          api: 'openai-compatible',
          name: 'Test X',
          options: { apiKey: 'sk-placeholder' },
          models: { 'test': { name: 'Test' } },
        },
      },
    },
  });
  console.log('RESULT:', r.error ? `FAILED: ${r.error.data?.message}` : 'SUCCESS ✓');
} catch (e) {
  console.error('CAUGHT:', e.message);
}

// Test 2: try without the nested 'config' object (plain body)
console.log('\n--- Test B: Direct raw HTTP call (PATCH /config) ---');
try {
  const raw = await fetch('http://127.0.0.1:4096/config', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: {
        'acp-test-y': {
          api: 'openai-compatible',
          name: 'Test Y',
          options: { apiKey: 'sk-placeholder' },
          models: { 'test': { name: 'Test' } },
        },
      },
    }),
  });
  const text = await raw.text();
  console.log(`STATUS: ${raw.status}`);
  console.log('BODY:', text.substring(0, 200));
} catch (e) {
  console.error('CAUGHT:', e.message);
}

// Test 3: try PATCH /global/config
console.log('\n--- Test C: PATCH /global/config ---');
try {
  const raw = await fetch('http://127.0.0.1:4096/global/config', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: {
        provider: {
          'acp-test-z': {
            api: 'openai-compatible',
            name: 'Test Z',
            options: { apiKey: 'sk-placeholder' },
            models: { 'test': { name: 'Test' } },
          },
        },
      },
    }),
  });
  const text = await raw.text();
  console.log(`STATUS: ${raw.status}`);
  console.log('BODY:', text.substring(0, 200));
} catch (e) {
  console.error('CAUGHT:', e.message);
}
