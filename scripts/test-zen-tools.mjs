/**
 * Test: verify tool calls with OpenCode Zen.
 */
const BASE = 'https://opencode.ai/zen/v1';
const MODEL = 'minimax-m3-free';

async function main() {
  const body = JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: 'List files in the current directory' }],
    tools: [{
      type: 'function',
      function: {
        name: 'read_dir',
        description: 'Read the current directory',
        parameters: { type: 'object', properties: {} },
      },
    }],
    stream: true,
    // In production, set tool_choice: 'auto'
  });

  console.log(`=== Tool test: ${MODEL} ===\n`);
  const resp = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer public', 'Content-Type': 'application/json' },
    body,
  });
  const text = await resp.text();
  const lines = text.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]');

  let sawThinking = false;
  let sawText = false;
  let sawToolCall = false;

  for (const line of lines.slice(0, 30)) {
    try {
      const d = JSON.parse(line.slice(6));
      const delta = d.choices?.[0]?.delta;
      if (!delta) continue;
      const c = String(delta.content ?? '');

      if (c.includes('<think>') || c.includes('<thinking>')) sawThinking = true;
      if (c && !c.startsWith('</')) sawText = true;
      if (delta.tool_calls?.length) sawToolCall = true;

      if (c) console.log(`content: "${c.slice(0, 80)}${c.length > 80 ? '...' : ''}"`);
      if (delta.tool_calls) console.log(`tool_calls: ${JSON.stringify(delta.tool_calls).slice(0, 120)}`);
    } catch {}
  }

  console.log(`\nthinking found: ${sawThinking}, text found: ${sawText}, tool_calls found: ${sawToolCall}`);
}

main().catch(e => console.error(e.message));
