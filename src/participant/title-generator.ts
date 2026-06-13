import * as vscode from 'vscode';
import type { AcpEvent, AcpPartUpdatedEvent } from '../acp/types';
import type { ExtensionState } from '../types';
import { applySessionTitle, isPlaceholderSessionTitle } from './session-title';

// ===========================================================================
// Title Generation via lightweight LLM
// ===========================================================================

/**
 * Generate a short, descriptive session title from the first user prompt.
 *
 * Copilot-style path: use VS Code's built-in language model API first so
 * naming is independent from the active OpenCode backend/model. If no VS Code
 * model is available, fall back to the older backend child-session strategy.
 *
 * The caller should call `sessions.update()` on the real session with the
 * returned title.
 *
 * @returns The generated title, or `undefined` on any failure (the caller
 *          should fall back to the existing prompt-truncation logic).
 */
export async function generateSessionTitle(
  firstPrompt: string,
  state: ExtensionState,
  parentSessionId: string,
  directory: string | undefined,
): Promise<string | undefined> {
  const logger = state.outputChannel;

  // Guard against empty or very short prompts
  const normalized = firstPrompt.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length < 3) {
    return undefined;
  }

  const vscodeTitle = await generateTitleWithVsCodeLm(normalized, logger);
  if (vscodeTitle) {
    logger.appendLine(`[title-generator] VS Code LM generated title: "${vscodeTitle}"`);
    return vscodeTitle;
  }

  return generateTitleWithBackendSession(normalized, state, parentSessionId, directory);
}

export async function generateSessionTitleWithVsCodeLm(
  firstPrompt: string,
  state: ExtensionState,
): Promise<string | undefined> {
  const normalized = firstPrompt.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length < 3) {
    return undefined;
  }

  return generateTitleWithVsCodeLm(normalized, state.outputChannel);
}

async function generateTitleWithVsCodeLm(
  normalizedPrompt: string,
  logger: { appendLine(message: string): void },
): Promise<string | undefined> {
  const lm = vscode.lm as unknown as {
    selectChatModels?: (selector?: vscode.LanguageModelChatSelector) => Thenable<vscode.LanguageModelChat[]>;
    languageModelAccessInformation?: { canSendRequest(chat: vscode.LanguageModelChat): boolean | undefined };
  };

  if (typeof lm.selectChatModels !== 'function' || !vscode.LanguageModelChatMessage?.User) {
    return undefined;
  }

  try {
    const allModels = await lm.selectChatModels();
    const model = pickTitleModel(allModels, lm.languageModelAccessInformation);
    if (!model) {
      logger.appendLine('[title-generator] No VS Code LM available for title generation');
      return undefined;
    }

    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(buildTitlePrompt(normalizedPrompt))],
      {},
      undefined,
    );

    const text = await collectLmText(response.text);
    const cleaned = cleanGeneratedTitle(text);
    if (!cleaned) {
      logger.appendLine(`[title-generator] VS Code LM unusable response: "${text.slice(0, 80)}"`);
      return undefined;
    }

    return cleaned;
  } catch (err) {
    logger.appendLine(
      `[title-generator] VS Code LM title generation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

function pickTitleModel(
  models: readonly vscode.LanguageModelChat[],
  access: { canSendRequest(chat: vscode.LanguageModelChat): boolean | undefined } | undefined,
): vscode.LanguageModelChat | undefined {
  const allowed = models.filter((model) =>
    model.vendor === 'copilot' &&
    access?.canSendRequest(model) !== false,
  );
  if (allowed.length === 0) {
    return undefined;
  }

  const score = (model: vscode.LanguageModelChat): number => {
    const haystack = `${model.vendor} ${model.id} ${model.name} ${model.family}`.toLowerCase();
    let value = 0;
    value += 100;
    if (/nano|mini|small|fast|flash|haiku|lite/.test(haystack)) value += 25;
    if (/gpt-4\.1|gpt-4o|gpt-5/.test(haystack)) value += 10;
    return value;
  };

  return [...allowed].sort((a, b) => score(b) - score(a))[0];
}

async function collectLmText(text: AsyncIterable<string>): Promise<string> {
  let result = '';
  for await (const chunk of text) {
    result += chunk;
  }
  return result.trim();
}

export async function generateTitleWithBackendSession(
  normalized: string,
  state: ExtensionState,
  parentSessionId: string,
  directory: string | undefined,
): Promise<string | undefined> {
  const logger = state.outputChannel;
  let childSessionId: string | undefined;

  try {
    // 1. Create a child session for title generation.
    //    Using parentID keeps the session-tree clean.
    const createResult = await state.backend.sessions.create({
      parentId: parentSessionId,
      directory,
      title: 'Title Generator',
    });

    if (createResult.error || !createResult.data?.id) {
      logger.appendLine(
        `[title-generator] Failed to create child session: ${createResult.error ?? 'unknown'}`,
      );
      return undefined;
    }

    childSessionId = createResult.data.id;
    logger.appendLine(`[title-generator] Created child session ${childSessionId}`);

    // 2. Open the per-session event stream BEFORE sending the prompt
    //    so we don't miss any events.
    await state.backend.events.ensureStarted();
    const eventStream = state.backend.events.openSessionStream(childSessionId);

    // 3. Send the title-generation prompt.
    const titlePrompt = buildTitlePrompt(normalized);
    const promptResult = await state.backend.sessions.prompt(
      childSessionId,
      titlePrompt,
      directory,
    );

    if (promptResult.error) {
      logger.appendLine(
        `[title-generator] Prompt failed: ${promptResult.error}`,
      );
      return undefined;
    }

    // 4. Collect the plain-text response from the event stream.
    const responseText = await collectTextResponse(eventStream.stream);
    if (!responseText) {
      logger.appendLine('[title-generator] No text response received');
      return undefined;
    }

    // 5. Clean and validate the generated title.
    const cleaned = cleanGeneratedTitle(responseText);
    if (!cleaned) {
      logger.appendLine(
        `[title-generator] Unusable response: "${responseText.slice(0, 80)}"`,
      );
      return undefined;
    }

    logger.appendLine(`[title-generator] Generated title: "${cleaned}"`);
    return cleaned;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.appendLine(`[title-generator] Error: ${msg}`);
    return undefined;
  } finally {
    // 6. Best-effort cleanup of the child session.
    if (childSessionId) {
      try {
        state.backend.events.closeSessionStream(childSessionId);
        await state.backend.sessions.abort(childSessionId, directory);
      } catch {
        // Best effort - nothing we can do if cleanup fails.
      }
    }
  }
}

/**
 * Fire-and-forget helper used by both the handler (first-turn auto-gen) and
 * the `/retitle` command.  Calls `generateSessionTitle`, then applies the
 * result to the real session (backend update + sessionMap + sidebar refresh).
 *
 * @returns The generated title, or `undefined` on failure.
 */
export async function retitleSession(
  prompt: string,
  state: ExtensionState,
  backendSessionId: string,
  vscodeSessionId: string,
  directory: string | undefined,
): Promise<string | undefined> {
  const logger = state.outputChannel;
  const llmTitle = await generateSessionTitle(prompt, state, backendSessionId, directory);
  if (llmTitle && !isPlaceholderSessionTitle(llmTitle)) {
    await applySessionTitle(state, {
      backendSessionId,
      vscodeSessionId,
      title: llmTitle,
      directory,
      updateBackend: true,
      overwrite: true,
      source: 'manual',
    });
    logger.appendLine(`[title-gen] Title applied: "${llmTitle}"`);
  } else {
    logger.appendLine(`[title-gen] LLM returned unusable title: ${llmTitle ?? 'undefined'}`);
  }
  return llmTitle;
}

// ===========================================================================
// Prompt construction
// ===========================================================================

/**
 * Build a focused, low-token prompt that asks the model to produce a short
 * title.  Rules are included inline so every model (not just instruction-tuned
 * ones) produces something useable.
 */
export function buildTitlePrompt(userMessage: string): string {
  const truncated =
    userMessage.length > 360
      ? `${userMessage.slice(0, 357)}...`
      : userMessage;

  return [
    'Generate a short, descriptive title for a coding conversation.',
    '',
    'Rules:',
    '- Respond with ONLY the title text; no quotes, no explanation, no punctuation at the end',
    '- The title must capture the main topic or task the user is asking about',
    '- Write the title in the same natural language as the user request when clear',
    '- If the request mixes languages, use the dominant natural language',
    '- Preserve product names, APIs, file names, commands, code symbols, and proper nouns exactly',
    '- Keep it concise and specific to coding',
    '- Aim for 3-6 words; for languages without spaces, keep it similarly brief',
    '- Drop filler like "help with", "question about", "request for", or their equivalents',
    '- Examples: "React auth middleware" | "\u4fee\u590d session \u6807\u9898" | "VS Code tree view"',
    '',
    `User message: "${truncated}"`,
  ].join('\n');
}

// ===========================================================================
// Response parsing
// ===========================================================================

/**
 * Iterate the session's event stream and collect text-part content.
 *
 * `part.text` contains the FULL accumulated text for a given part, so we use
 * a Map keyed by part ID to correctly handle streaming updates (each update
 * overwrites the previous full text for that part). Multiple text parts are
 * joined in insertion order.
 *
 * Stops when a `session.idle` event is received.
 */
async function collectTextResponse(stream: AsyncIterable<AcpEvent>): Promise<string> {
  const textParts = new Map<string, string>();

  for await (const rawEvt of stream) {
    const evt = rawEvt as AcpEvent;

    if (evt.type === 'part.updated') {
      const partUpdated = evt as AcpPartUpdatedEvent;
      if (partUpdated.part.type === 'text') {
        // Overwrite with the latest full text for this part ID
        textParts.set(partUpdated.part.id, partUpdated.part.text);
      }
    }

    if (evt.type === 'session.idle') {
      break;
    }
  }

  return Array.from(textParts.values())
    .join('')
    .trim();
}

/**
 * Strip formatting artifacts from an LLM-generated title and validate it.
 * Returns `undefined` if the result is unusable.
 */
export function cleanGeneratedTitle(raw: string): string | undefined {
  // Remove formatting artifacts - order matters:
  // bold markers first, then surrounding quotes, so `**"title"**` works correctly.
  const cleaned = raw
    .replace(/\*\*/g, '')
    .replace(/^["'`\u201C\u201D\u2018\u2019]+|["'`\u201C\u201D\u2018\u2019]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/, '')
    .trim();

  if (!cleaned) {
    return undefined;
  }

  // Reject anything the model clearly failed to process
  if (cleaned.length > 80 || /^(i'm |i am |here|sorry|i can)/i.test(cleaned)) {
    return undefined;
  }

  return cleaned;
}
