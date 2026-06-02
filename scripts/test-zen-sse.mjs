/**
 * Test: capture raw SSE chunks from OpenCode Zen to determine
 * whether thinking/reasoning content appears in delta.content
 * or delta.reasoning_content.
 */
const BASE = 'https://opencode.ai/zen/v1';
const MODEL = 'minimax-m3-free';

async function main() {
  const body = JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: 'Say: hello world' }],
    stream: true,
  });

  console.log(`=== Testing ${MODEL} at ${BASE}/chat/completions ===\n`);

  const resp = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer public',
      'Content-Type': 'application/json',
    },
    body,
  });

  console.log(`Status: ${resp.status}\n`);

  const text = await resp.text();
  const lines = text.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]');

  console.log(`Total SSE chunks: ${lines.length}\n`);

  let hadReasoning = false;
  let hadContent = false;

  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    try {
      const parsed = JSON.parse(lines[i].slice(6));
      const delta = parsed.choices?.[0]?.delta ?? parsed.choices?.[0]?.message ?? {};

      const reasoning = delta.reasoning_content;
      const content = delta.content;
      const keys = Object.keys(delta).filter(k => delta[k] != null);

      if (reasoning) hadReasoning = true;
      if (content) hadContent = true;

      console.log(`[${i}] keys=${JSON.stringify(keys)}`);
      if (reasoning) console.log(`    reasoning_content: "${reasoning.slice(0, 80)}${reasoning.length > 80 ? '...' : ''}"`);
      if (content) console.log(`    content: "${content.slice(0, 80)}${content.length > 80 ? '...' : ''}"`);
      if (delta.tool_calls) console.log(`    tool_calls: ${JSON.stringify(delta.tool_calls).slice(0, 120)}`);
    } catch { console.log(`[${i}] parse error`); }
  }

  console.log(`\n=== Summary ===`);
  console.log(`reasoning_content present: ${hadReasoning}`);
  console.log(`content present: ${hadContent}`);
  console.log(`\nCONCLUSION: ${hadReasoning ? 'reasoning IS in delta.reasoning_content' : 'reasoning is ONLY in delta.content (wrapped in  response tags)'}`);
}

main().catch(e => console.error('FATAL:', e.message));
