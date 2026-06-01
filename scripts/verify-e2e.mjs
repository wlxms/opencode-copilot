/**
 * v2 SDK full end-to-end: auth.set + global.config.update → provider available → prompt
 */
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';

const c = createOpencodeClient({ baseUrl: 'http://127.0.0.1:4096' });

console.log('=== Step 1: Write key via auth.set ===');
const authResult = await c.auth.set({
  providerID: 'acp-deepseek-bridge',
  auth: { type: 'api', key: process.env.DEEPSEEK_API_KEY ?? 'set-DEEPSEEK_API_KEY-env-var' },
});
console.log('auth.set:', authResult.error ? 'FAILED' : 'OK ✓');

console.log('\n=== Step 2: Write provider config via global.config.update ===');
// First get current global config
const currentGlobal = await c.global.config.get({});
const currentProviders = currentGlobal.data?.provider ?? {};

// Add our bridge provider to existing providers
const updateResult = await c.global.config.update({
  config: {
    provider: {
      ...currentProviders,
      'acp-deepseek-bridge': {
        api: 'deepseek',
        name: 'ACP DeepSeek Bridge',
        models: {
          'deepseek-v4-flash': { name: 'DeepSeek V4 Flash (bridge)' },
          'deepseek-chat': { name: 'DeepSeek Chat (bridge)' },
        },
      },
    },
  },
});
console.log('global.config.update:', updateResult.error ? 'FAILED' : 'OK ✓');

console.log('\n=== Step 3: Check if provider appears in config.providers listing ===');
const providersResult = await c.config.providers({});
const found = providersResult.data?.providers?.find(p => p.id === 'acp-deepseek-bridge');
console.log('Provider visible:', found ? `YES ✓ (models: ${Object.keys(found.models ?? {}).join(', ')})` : 'NOT YET (may need restart)');

console.log('\n=== Step 4: Try to create session + prompt with bridge provider ===');
try {
  const session = await c.session.create({ title: 'acp-bridge-test' });
  const sid = session.data?.id;
  console.log('Session:', sid ?? 'FAILED');
  if (sid) {
    const prompt = await c.session.prompt({
      sessionID: sid,
      model: { providerID: 'acp-deepseek-bridge', modelID: 'deepseek-v4-flash' },
      parts: [{ type: 'text', text: 'Reply with: OK' }],
    });
    console.log('Prompt:', prompt.error ? `FAILED: ${prompt.error.data?.message ?? 'unknown'}` : 'SUCCESS ✓');
  }
} catch (e) {
  console.log('Prompt threw:', e.message);
}

console.log('\n=== Cleanup ===');
await c.auth.remove({ providerID: 'acp-deepseek-bridge' });
// Remove from global config
const cleanProviders = { ...currentProviders };
delete cleanProviders['acp-deepseek-bridge'];
await c.global.config.update({ config: { provider: cleanProviders } });
console.log('Cleanup done ✓');
