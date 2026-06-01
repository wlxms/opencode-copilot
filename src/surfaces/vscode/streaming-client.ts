/**
 * Streaming clients for per-provider LM API calls.
 *
 * Supports: text, reasoning (thinking), and tool calling.
 *
 * @module
 */

import * as vscode from 'vscode';
import { streamText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { AcpProviderMeta } from '../../acpmodels/types';

// ===========================================================================
// Types
// ===========================================================================

interface PerProviderCallOptions {
  providerMeta: AcpProviderMeta;
  apiKey: string;
  modelId: string;
  messages: readonly vscode.LanguageModelChatRequestMessage[];
  tools?: readonly vscode.LanguageModelChatTool[];
  progress: vscode.Progress<vscode.LanguageModelResponsePart2>;
  token: vscode.CancellationToken;
}

// ===========================================================================
// Public API
// ===========================================================================

export async function streamViaProvider(opts: PerProviderCallOptions): Promise<void> {
  const { providerMeta, apiKey, modelId, messages, tools, progress, token } = opts;

  const aiMessages: any[] = [];
  for (const msg of messages) {
    const parts: Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }> = [];
    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        const last = parts[parts.length - 1];
        if (last && last.type === 'text') {
          last.text = (last.text ?? '') + '\n' + part.value;
        } else {
          parts.push({ type: 'text', text: part.value });
        }
      }
      if (part instanceof vscode.LanguageModelDataPart) {
        try {
          const raw = part as unknown as { mimeType?: string; value?: Uint8Array };
          const mime = raw.mimeType ?? 'image/png';
          const base64 = Buffer.from(raw.value ?? new Uint8Array(0)).toString('base64');
          parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } });
        } catch { /* skip */ }
      }
    }
    if (parts.length > 0) {
      aiMessages.push({
        role: msg.role === 1 ? 'user' : 'assistant',
        content: parts.length === 1 && parts[0].type === 'text' ? (parts[0].text ?? '') : parts,
      });
    }
  }

  const abortController = new AbortController();
  token.onCancellationRequested(() => abortController.abort());

  // Convert VS Code tools → AI SDK tools
  const aiTools = convertTools(tools) as any;

  // ── OpenCode Zen: multi-endpoint routing ──
  if (providerMeta.id === 'opencode' || providerMeta.id === 'opencode-zen') {
    const key = apiKey || 'public';
    if (modelId.startsWith('claude-')) {
      await doStreamAnthropic(key, providerMeta.baseURL, modelId, aiMessages, aiTools, progress, abortController);
    } else if (modelId.startsWith('gpt-')) {
      await streamOpenCodeResponses(key, providerMeta.baseURL, modelId, aiMessages, progress, abortController);
    } else if (modelId.startsWith('gemini-')) {
      await streamOpenCodeGemini(key, providerMeta.baseURL, modelId, aiMessages, progress, abortController);
    } else {
      // Free / OpenAI-compatible models → raw fetch for reliability
      await streamOpenCodeOAI(key, providerMeta.baseURL, modelId, aiMessages, progress, abortController);
    }
    return;
  }

  // ── Standard routing by npm ──
  const npm = providerMeta.npm;
  if (npm.includes('@ai-sdk/anthropic')) {
    await doStreamAnthropic(apiKey, providerMeta.baseURL, modelId, aiMessages, aiTools, progress, abortController);
  } else if (npm.includes('@ai-sdk/openai') && !npm.includes('compatible')) {
    await doStreamOpenAI(apiKey, providerMeta.baseURL, modelId, aiMessages, aiTools, progress, abortController);
  } else if (npm.includes('@ai-sdk/google')) {
    await doStreamGoogle(apiKey, modelId, aiMessages, aiTools, progress, abortController);
  } else {
    await doStreamOAICompat(apiKey, providerMeta.baseURL, modelId, aiMessages, aiTools, progress, abortController);
  }
}

// ===========================================================================
// Tool conversion
// ===========================================================================

function convertTools(tools?: readonly vscode.LanguageModelChatTool[]): Record<string, unknown> | undefined {
  if (!tools || tools.length === 0) return undefined;
  const result: Record<string, unknown> = {};
  for (const t of tools) {
    result[t.name] = {
      description: t.description ?? '',
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// ===========================================================================
// Stream → VS Code progress (handles text + reasoning + tool calls)
// ===========================================================================

async function streamResultToProgress(
  result: Awaited<ReturnType<typeof streamText>>,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): Promise<void> {
  let hadContent = false;

  // Stream reasoning text when available (non-streaming — full text after completion)
  try {
    const reasoning = await result.reasoningText;
    if (reasoning) {
      const id = `reason-${Date.now()}`;
      progress.report(new vscode.LanguageModelThinkingPart(reasoning, id));
      progress.report(new vscode.LanguageModelThinkingPart('', id, { vscode_reasoning_done: true } as any));
      hadContent = true;
    }
  } catch { /* model may not support reasoning */ }

  // Stream text content
  try {
    for await (const chunk of result.textStream) {
      progress.report(new vscode.LanguageModelTextPart(chunk));
      hadContent = true;
    }
  } catch (err) {
    if (!hadContent) throw err;
  }

  // Report tool calls (after full response)
  try {
    const toolCalls = await result.toolCalls;
    for (const tc of toolCalls) {
      const input = (tc as unknown as { input?: Record<string, unknown> }).input
        ?? (tc as unknown as { args?: Record<string, unknown> }).args
        ?? {};
      progress.report(new vscode.LanguageModelToolCallPart(
        tc.toolCallId,
        tc.toolName,
        input,
      ));
    }
  } catch { /* tool calls may error */ }
}

// ===========================================================================
// Per-provider implementations
// ===========================================================================

// Change all internal function signatures to accept `any` for messages
// (handles both plain-text and multimodal content arrays)

async function doStreamOAICompat(
  apiKey: string, baseURL: string, modelId: string,
  messages: any[],
  tools: any,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  abortController: AbortController,
) {
  const provider = createOpenAICompatible({ apiKey, baseURL, name: 'acp' });
  const result = streamText({
    model: provider.chatModel(modelId),
    messages,
    tools,
    abortSignal: abortController.signal,
  });
  await streamResultToProgress(result, progress);
}

async function doStreamAnthropic(
  apiKey: string, baseURL: string, modelId: string,
  messages: any[],
  tools: any,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  abortController: AbortController,
) {
  const provider = createAnthropic({ apiKey, baseURL });
  const result = streamText({
    model: provider(modelId),
    messages,
    tools,
    abortSignal: abortController.signal,
  });
  await streamResultToProgress(result, progress);
}

async function doStreamOpenAI(
  apiKey: string, baseURL: string, modelId: string,
  messages: any[],
  tools: any,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  abortController: AbortController,
) {
  const provider = createOpenAI({ apiKey, baseURL });
  const result = streamText({
    model: provider(modelId),
    messages,
    tools,
    abortSignal: abortController.signal,
  });
  await streamResultToProgress(result, progress);
}

async function doStreamGoogle(
  apiKey: string, modelId: string,
  messages: any[],
  tools: any,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  abortController: AbortController,
) {
  const provider = createGoogleGenerativeAI({ apiKey });
  const result = streamText({
    model: provider(modelId),
    messages,
    tools,
    abortSignal: abortController.signal,
  });
  await streamResultToProgress(result, progress);
}

// ===========================================================================
// OpenCode Zen custom routes (raw fetch)
// ===========================================================================

/**
 * OpenAI-compatible Chat Completions endpoint for OpenCode Zen.
 * Uses raw fetch to avoid AI SDK compatibility issues with the "public" auth.
 */
async function streamOpenCodeOAI(
  apiKey: string, baseURL: string, modelId: string,
  messages: any[],
  progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
  abortController: AbortController,
) {
  // Convert messages: OpenAI Chat Completions expects string content.
  // VS Code roles: 1=User, 2=Assistant. Map to OAI strings.
  const flatMessages: Array<{ role: string; content: string }> = [];
  for (const m of messages) {
    let role: string;
    const r = m.role as number;
    if (r === 1) role = 'user';
    else if (r === 2) role = 'assistant';
    else if (r === 0) role = 'system';
    else role = 'user';

    const content = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content)
          ? m.content
              .map((p: any) => p.type === 'text' ? (p.text ?? '') : `[${p.type}]`)
              .join('\n')
          : String(m.content ?? ''));

    if (content) {
      flatMessages.push({ role, content });
    }
  }

  const body = JSON.stringify({
    model: modelId,
    messages: flatMessages,
    stream: true,
  });

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body,
    signal: abortController.signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Zen /chat/completions ${response.status}: ${errText.slice(0, 400)}`);
  }

  // Parse SSE stream with  response tag handling.
  // OpenCode Zen returns thinking content inline in delta.content,
  // wrapped in  response tags. We track the tag state
  // and report thinking vs text accordingly.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const TAGS = [
    /<tool_call>/gi, /<\/tool_call>/gi,
    /<tool_name>/gi, /<\/tool_name>/gi,
    /<argument>.*?<\/argument>/gis,
  ];

  const decoder = new TextDecoder();
  let rawBuffer = '';
  let thinkingActive = false;
  let thinkingId: string | undefined;
  let textBuffer = '';

  function flushText() {
    if (textBuffer) {
      progress.report(new vscode.LanguageModelTextPart(textBuffer));
      textBuffer = '';
    }
  }

  function startThinking() {
    flushText();
    thinkingId = `think-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    thinkingActive = true;
  }

  function endThinking() {
    if (thinkingActive) {
      progress.report(new vscode.LanguageModelThinkingPart('', thinkingId, { vscode_reasoning_done: true } as any));
      thinkingActive = false;
      thinkingId = undefined;
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      rawBuffer += decoder.decode(value, { stream: true });

      // Process complete SSE lines
      const lines = rawBuffer.split('\n');
      rawBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') { endThinking(); flushText(); return; }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;

          // Also try reasoning_content if present (some providers use it)
          if (delta?.reasoning_content) {
            if (!thinkingActive) startThinking();
            progress.report(new vscode.LanguageModelThinkingPart(String(delta.reasoning_content), thinkingId));
            continue;
          }

          // Handle delta.content — may contain  response tags
          if (delta?.content) {
            let chunk = String(delta.content);
            let pos = 0;

            while (pos < chunk.length) {
              // Find next  or  or  response or  or ]
              const nextThink = chunk.indexOf('<think>', pos);
              const nextEndThink = chunk.indexOf('</think>', pos);
              const nextResponse = chunk.indexOf('<response>', pos);
              const nextEndResponse = chunk.indexOf('</response>', pos);
              const candidates = [
                nextThink, nextEndThink, nextResponse, nextEndResponse,
                chunk.indexOf('<thinking>', pos), chunk.indexOf('</thinking>', pos),
                chunk.indexOf('<thought>', pos), chunk.indexOf('</thought>', pos),
                chunk.indexOf('[thinking]', pos), chunk.indexOf('[/thinking]', pos),
              ].filter(c => c >= 0);
              const nextTag = candidates.length > 0 ? Math.min(...candidates) : -1;

              if (nextTag < 0) {
                // No more tags — emit remaining text
                const remaining = chunk.slice(pos);
                if (remaining) {
                  if (thinkingActive)
                    progress.report(new vscode.LanguageModelThinkingPart(remaining, thinkingId));
                  else
                    textBuffer += remaining;
                }
                break;
              }

              // Emit text before the tag
              if (nextTag > pos) {
                const before = chunk.slice(pos, nextTag);
                if (thinkingActive)
                  progress.report(new vscode.LanguageModelThinkingPart(before, thinkingId));
                else
                  textBuffer += before;
              }

              // Determine which tag and its length
              let tagLen = 0;
              let isStart = false;
              let isEnd = false;
              if (nextThink === nextTag) { tagLen = '<think>'.length; isStart = true; }
              else if (nextEndThink === nextTag) { tagLen = '</think>'.length; isEnd = true; }
              else if (nextResponse === nextTag) { tagLen = '<response>'.length; isStart = true; }
              else if (nextEndResponse === nextTag) { tagLen = '</response>'.length; isEnd = true; }
              else if (chunk.startsWith('<thinking>', nextTag)) { tagLen = '<thinking>'.length; isStart = true; }
              else if (chunk.startsWith('</thinking>', nextTag)) { tagLen = '</thinking>'.length; isEnd = true; }
              else if (chunk.startsWith('<thought>', nextTag)) { tagLen = '<thought>'.length; isStart = true; }
              else if (chunk.startsWith('</thought>', nextTag)) { tagLen = '</thought>'.length; isEnd = true; }
              else if (chunk.startsWith('[thinking]', nextTag)) { tagLen = '[thinking]'.length; isStart = true; }
              else if (chunk.startsWith('[/thinking]', nextTag)) { tagLen = '[/thinking]'.length; isEnd = true; }

              if (tagLen > 0) {
                if (isStart && !thinkingActive) startThinking();
                if ((isEnd || isStart) && thinkingActive) {
                  if (isEnd) endThinking();
                }
              }

              pos = nextTag + tagLen;
            }
          }

          // Handle tool calls
          if (delta?.tool_calls) {
            flushText();
            endThinking();
            for (const tc of delta.tool_calls) {
              if (tc.function) {
                progress.report(new vscode.LanguageModelToolCallPart(
                  tc.id ?? tc.index ?? 'unknown',
                  tc.function.name ?? 'unknown',
                  safeParseJson(tc.function.arguments ?? '{}'),
                ));
              }
            }
          }
        } catch { /* skip malformed */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function safeParseJson(input: string): Record<string, unknown> {
  try { return JSON.parse(input); } catch { return {}; }
}

async function streamOpenCodeResponses(
  apiKey: string, baseURL: string, modelId: string,
  messages: any[],
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  abortController: AbortController,
) {
  const lastMsg = messages[messages.length - 1]?.content ?? '';
  const resp = await fetch(`${baseURL}/responses`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelId, input: lastMsg, stream: true }),
    signal: abortController.signal,
  });
  if (!resp.ok) throw new Error(`OpenCode GPT /responses returned ${resp.status}`);
  const text = await resp.text();
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const d = JSON.parse(line.slice(6));
      if (d.delta) progress.report(new vscode.LanguageModelTextPart(d.delta));
      if (Array.isArray(d.content)) {
        for (const p of d.content) {
          if (p.type === 'output_text' && p.text) progress.report(new vscode.LanguageModelTextPart(p.text));
        }
      }
    } catch { /* skip */ }
  }
}

async function streamOpenCodeGemini(
  apiKey: string, baseURL: string, modelId: string,
  messages: any[],
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  abortController: AbortController,
) {
  const body = JSON.stringify({
    contents: messages.map((m: any) => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
    })),
  });
  const resp = await fetch(`${baseURL}/models/${modelId}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body,
    signal: abortController.signal,
  });
  if (!resp.ok) throw new Error(`OpenCode Gemini returned ${resp.status}`);
  const text = await resp.text();
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const d = JSON.parse(line.slice(6));
      const parts = d.candidates?.[0]?.content?.parts;
      if (parts) {
        for (const p of parts) {
          if (p.text) progress.report(new vscode.LanguageModelTextPart(p.text));
        }
      }
    } catch { /* skip */ }
  }
}
