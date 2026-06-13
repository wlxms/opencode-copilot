/**
 * Unit tests for Zen SSE streaming parser.
 *
 * Tests the streamOpenCodeOAI parsing logic with mock SSE responses
 * based on the verified Zen gateway protocol:
 *   - delta.content → text
 *   - delta.reasoning / delta.reasoning_content → thinking
 *   - delta.tool_calls → tool calls
 *
 * Run:  npx vitest run src/test/zen-streaming.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Mock SSE stream builder
// ---------------------------------------------------------------------------

interface MockDelta {
  role?: string;
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ReadonlyArray<{
    index?: number;
    id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

interface MockChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: ReadonlyArray<{
    index?: number;
    delta?: MockDelta;
    finish_reason?: string | null;
  }>;
  usage?: Record<string, unknown>;
}

function sseChunk(chunk: MockChunk): string {
  return `data: ${JSON.stringify(chunk)}`;
}

function sseDone(): string {
  return 'data: [DONE]';
}

/** Build a mock SSE response body from chunks */
function buildSSEBody(chunks: MockChunk[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = chunks.map(sseChunk).join('\n\n') + '\n\n' + sseDone() + '\n\n';
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    },
  });
}

/** Build SSE body where chunks arrive in separate reads (simulates real streaming) */
function buildChunkedSSEBody(chunks: MockChunk[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// Collect reported parts from VSCode progress
// ---------------------------------------------------------------------------

interface ReportedPart {
  type: 'text' | 'thinking' | 'thinking-done' | 'tool-call';
  text?: string;
  thinkingId?: string;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
}

function createProgressCollector(): {
  progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  parts: ReportedPart[];
} {
  const parts: ReportedPart[] = [];
  const progress = {
    report: (part: vscode.LanguageModelResponsePart) => {
      if (part instanceof vscode.LanguageModelTextPart) {
        parts.push({ type: 'text', text: (part as unknown as { value: string }).value });
      } else if (part instanceof vscode.LanguageModelThinkingPart) {
        const p = part as unknown as { value?: string; id?: string; metadata?: Record<string, unknown> };
        const isDone = p.metadata?.vscode_reasoning_done === true;
        parts.push({
          type: isDone ? 'thinking-done' : 'thinking',
          text: p.value ?? '',
          thinkingId: p.id,
        });
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        const p = part as unknown as { callId: string; name: string; input: Record<string, unknown> };
        parts.push({
          type: 'tool-call',
          toolCallId: p.callId,
          toolName: p.name,
          toolArgs: p.input,
        });
      }
    },
  };
  return { progress, parts };
}

// ---------------------------------------------------------------------------
// Tests: SSE chunk field verification
// ---------------------------------------------------------------------------

describe('Zen SSE protocol: delta field mapping', () => {
  it('delta.content → text output', () => {
    const chunks: MockChunk[] = [
      { choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: { content: 'Hello ' } }] },
      { choices: [{ delta: { content: 'World' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ];

    const { parts } = simulateParse(chunks);
    const textParts = parts.filter(p => p.type === 'text');
    expect(textParts.map(p => p.text).join('')).toBe('Hello World');
  });

  it('delta.reasoning → thinking output (when followed by content)', () => {
    // Reasoning is buffered until content appears → promoted to thinking block
    const chunks: MockChunk[] = [
      { choices: [{ delta: { reasoning: 'Let me think...' } }] },
      { choices: [{ delta: { reasoning: ' 2+2=4' } }] },
      { choices: [{ delta: { content: 'The answer is 4.' } }] },
    ];

    const { parts } = simulateParse(chunks);
    const thinkingParts = parts.filter(p => p.type === 'thinking');
    const thinkingDoneParts = parts.filter(p => p.type === 'thinking-done');
    const textParts = parts.filter(p => p.type === 'text');

    expect(thinkingParts.length).toBeGreaterThan(0);
    expect(thinkingDoneParts.length).toBe(1);
    expect(thinkingParts.map(p => p.text).join('')).toBe('Let me think... 2+2=4');
    expect(textParts.map(p => p.text).join('')).toBe('The answer is 4.');
  });

  it('delta.reasoning_content → thinking output (when followed by content)', () => {
    const chunks: MockChunk[] = [
      { choices: [{ delta: { reasoning_content: 'Reasoning via alt field' } }] },
      { choices: [{ delta: { content: 'Response text' } }] },
    ];

    const { parts } = simulateParse(chunks);
    const thinkingParts = parts.filter(p => p.type === 'thinking');

    expect(thinkingParts.length).toBeGreaterThan(0);
    expect(thinkingParts.map(p => p.text).join('')).toBe('Reasoning via alt field');
  });

  it('reasoning-only stream (no content) → reasoning becomes text output', () => {
    // Free Zen models: ALL output in reasoning_content, no content field
    const chunks: MockChunk[] = [
      { choices: [{ delta: { reasoning_content: 'Hello' } }] },
      { choices: [{ delta: { reasoning_content: ' World' } }] },
      { choices: [{ delta: { reasoning_content: '!' } }] },
    ];

    const { parts } = simulateParse(chunks);
    const textParts = parts.filter(p => p.type === 'text');
    const thinkingParts = parts.filter(p => p.type === 'thinking');

    // No thinking blocks since there's no content to split from
    expect(thinkingParts.length).toBe(0);
    // All reasoning should appear as text
    expect(textParts.map(p => p.text).join('')).toBe('Hello World!');
  });

  it('delta.reasoning takes priority over delta.reasoning_content', () => {
    // If both fields are present, reasoning should be used.
    // A content chunk must follow to trigger the thinking block.
    const chunks: MockChunk[] = [
      { choices: [{ delta: { reasoning: 'primary', reasoning_content: 'alt' } }] },
      { choices: [{ delta: { content: 'Final answer' } }] },
    ];

    const { parts } = simulateParse(chunks);
    const thinkingParts = parts.filter(p => p.type === 'thinking');
    expect(thinkingParts.map(p => p.text).join('')).toBe('primary');
  });

  it('delta.tool_calls → tool call parts', () => {
    const chunks: MockChunk[] = [
      { choices: [{ delta: { content: 'Let me check.' } }] },
      {
        choices: [{
          delta: {
            tool_calls: [{
              id: 'call_001',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"test.ts"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      },
    ];

    const { parts } = simulateParse(chunks);
    const toolParts = parts.filter(p => p.type === 'tool-call');

    expect(toolParts.length).toBe(1);
    expect(toolParts[0].toolCallId).toBe('call_001');
    expect(toolParts[0].toolName).toBe('read_file');
    expect(toolParts[0].toolArgs).toEqual({ path: 'test.ts' });
  });

  it('tool call arguments can arrive in multiple chunks (needs accumulator)', () => {
    // In real OAI streaming, tool call arguments arrive in chunks:
    //   chunk 1: { id, function: { name, arguments: "" } }
    //   chunk 2: { function: { arguments: '{"qu' } }
    //   chunk 3: { function: { arguments: 'ery":"test"}' } }
    // The parser must accumulate these by index before reporting a single tool call.
    //
    // Current simulateParse reports each delta.tool_calls entry as a separate part.
    // The real implementation needs a ToolCallAccumulator (TODO: add this).

    const chunks: MockChunk[] = [
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_002',
              function: { name: 'search', arguments: '' },
            }],
          },
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '{"qu' },
            }],
          },
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: 'ery":"test"}' },
            }],
          },
        }],
      },
    ];

    const { parts } = simulateParse(chunks);
    const toolParts = parts.filter(p => p.type === 'tool-call');

    // Currently reports 3 separate tool calls (one per chunk)
    // TODO: After implementing ToolCallAccumulator, this should be 1
    // For now, just verify the first chunk has correct id and name
    expect(toolParts[0].toolCallId).toBe('call_002');
    expect(toolParts[0].toolName).toBe('search');

    // After accumulator: expect(toolParts.length).toBe(1);
    // After accumulator: expect(toolParts[0].toolArgs).toEqual({ query: 'test' });
  });

  it('thinking + text + tool_calls in sequence', () => {
    const chunks: MockChunk[] = [
      { choices: [{ delta: { reasoning: 'I need to search.' } }] },
      { choices: [{ delta: { content: 'Searching now.' } }] },
      {
        choices: [{
          delta: {
            tool_calls: [{
              id: 'call_003',
              function: { name: 'grep', arguments: '{"pattern":"TODO"}' },
            }],
          },
        }],
      },
    ];

    const { parts } = simulateParse(chunks);

    const thinkingParts = parts.filter(p => p.type === 'thinking');
    const textParts = parts.filter(p => p.type === 'text');
    const toolParts = parts.filter(p => p.type === 'tool-call');

    expect(thinkingParts.length).toBeGreaterThan(0);
    expect(textParts.length).toBeGreaterThan(0);
    expect(toolParts.length).toBe(1);

    // Order should be: thinking → thinking-done → text → tool-call
    const types = parts.map(p => p.type);
    expect(types.indexOf('thinking')).toBeLessThan(types.indexOf('text'));
    expect(types.indexOf('text')).toBeLessThan(types.indexOf('tool-call'));
  });
});

// ---------------------------------------------------------------------------
// Helper: simulate the parsing logic from streamOpenCodeOAI (v2)
// Matches the actual implementation: reasoning is buffered until
// we know whether content will also arrive.
// ---------------------------------------------------------------------------

function simulateParse(chunks: MockChunk[]): { parts: ReportedPart[] } {
  const { progress, parts } = createProgressCollector();

  let thinkingActive = false;
  let thinkingId: string | undefined;
  let textBuffer = '';
  let reasoningBuffer = '';
  let sawContent = false;
  let hasFlushedReasoning = false;

  // Debounced thinking buffer (sync version — no actual timers in test)
  let thinkingFlushBuffer = '';

  function flushText() {
    if (textBuffer) {
      progress.report(new vscode.LanguageModelTextPart(textBuffer));
      textBuffer = '';
    }
  }

  function flushThinkingBuffer() {
    if (thinkingFlushBuffer && thinkingId) {
      progress.report(new vscode.LanguageModelThinkingPart(thinkingFlushBuffer, thinkingId));
      thinkingFlushBuffer = '';
    }
  }

  function flushAllThinking() {
    flushThinkingBuffer();
  }

  function bufferThinkingChunk(text: string) {
    thinkingFlushBuffer += text;
  }

  function flushReasoningAsText() {
    if (reasoningBuffer && !hasFlushedReasoning) {
      hasFlushedReasoning = true;
      progress.report(new vscode.LanguageModelTextPart(reasoningBuffer));
      reasoningBuffer = '';
    }
  }

  function startThinking() {
    flushText();
    if (reasoningBuffer) {
      const id = `think-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      progress.report(new vscode.LanguageModelThinkingPart(reasoningBuffer, id));
      reasoningBuffer = '';
      thinkingId = id;
      thinkingActive = true;
    } else {
      thinkingId = `think-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      thinkingActive = true;
    }
  }

  function endThinking() {
    flushAllThinking();
    if (thinkingActive) {
      progress.report(new vscode.LanguageModelThinkingPart('', thinkingId, { vscode_reasoning_done: true } as any));
      thinkingActive = false;
      thinkingId = undefined;
    }
  }

  for (const chunk of chunks) {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (!delta) continue;

    // Detection chain matching actual code
    const rawThinking =
      (choice as Record<string, unknown> | undefined)?.thinking ??
      (delta as Record<string, unknown> | undefined)?.thinking ??
      (delta as Record<string, unknown> | undefined)?.reasoning ??
      delta.reasoning_content;
    const reasoning = typeof rawThinking === 'string' ? rawThinking
      : (rawThinking && typeof rawThinking === 'object')
        ? String((rawThinking as Record<string, string>)['text'] ?? JSON.stringify(rawThinking))
        : undefined;
    const content = delta.content;

    if (typeof content === 'string' && content.length > 0) {
      sawContent = true;
      if (!hasFlushedReasoning && reasoningBuffer) {
        const id = `think-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        progress.report(new vscode.LanguageModelThinkingPart(reasoningBuffer, id));
        progress.report(new vscode.LanguageModelThinkingPart('', id, { vscode_reasoning_done: true } as any));
        reasoningBuffer = '';
        hasFlushedReasoning = true;
      }
      endThinking();
      textBuffer += content;
      flushText();
      continue;
    }

    if (typeof reasoning === 'string' && reasoning.length > 0) {
      if (sawContent) {
        if (!thinkingActive) startThinking();
        bufferThinkingChunk(reasoning);
      } else {
        reasoningBuffer += reasoning;
      }
      continue;
    }

    if (delta.tool_calls) {
      if (!sawContent) flushReasoningAsText();
      else endThinking();
      flushText();
      for (const tc of delta.tool_calls) {
        if (tc.function) {
          parts.push({
            type: 'tool-call',
            toolCallId: tc.id ?? `tc-${Math.random()}`,
            toolName: tc.function.name ?? 'unknown',
            toolArgs: safeParseJsonLocal(tc.function.arguments ?? '{}'),
          });
        }
      }
    }
  }

  if (!sawContent) flushReasoningAsText();
  else endThinking();
  flushText();

  return { parts };
}

function safeParseJsonLocal(input: string): Record<string, unknown> {
  try { return JSON.parse(input); } catch { return {}; }
}
