/**
 * Phase 2: Test config.update() with a generic provider
 */
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';

const c = createOpencodeClient({ baseUrl: 'http://127.0.0.1:4096' });

console.log('--- Test 1: config.update() with openai-compatible provider ---');
try {
  const r = await c.config.update({
    config: {
      provider: {
        'acp-test-bridge': {
          api: 'openai-compatible',
          name: 'ACP Test Bridge',
          options: {
            apiKey: 'sk-placeholder',
            baseURL: 'https://test.example.com/v1',
          },
          models: {
            'test-model': { name: 'Test Model' },
          },
        },
      },
    },
  });
  console.log('RESULT:', JSON.stringify(r, null, 2));
  console.log('STATUS:', r.error ? 'FAILED' : 'SUCCESS ✓');
  if (r.error) {
    console.log('ERROR DETAIL:', JSON.stringify(r.error));
  }
} catch (e) {
  console.error('CAUGHT:', e.message);
}

console.log('\n--- Test 2: Verify persistence ---');
try {
  const check = await c.config.get({});
  const hasBridge = check.data?.provider?.['acp-test-bridge'];
  console.log('Provider persisted:', !!hasBridge);
  if (hasBridge) console.log('Full entry:', JSON.stringify(hasBridge, null, 2));
  
  const allKeys = Object.keys(check.data?.provider ?? {});
  console.log('All provider keys:', allKeys.join(', ') || '(none)');
} catch (e) {
  console.error('CAUGHT:', e.message);
}
