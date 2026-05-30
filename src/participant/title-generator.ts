import type { AcpEvent, AcpPartUpdatedEvent } from '../acp/types';
import type { ExtensionState } from '../types';
import { isPlaceholderSessionTitle } from '../surfaces/vscode/experimental-session';

// ===========================================================================
// Title Generation via lightweight LLM
// ===========================================================================

/**
 * Generate a short, descriptive session title from the first user prompt
 * using a lightweight LLM call.
 *
 * Creates a temporary child session, sends a focused title-generation prompt,
 * captures the plain-text response, cleans up, and returns the title.
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
  let childSessionId: string | undefined;

  // Guard against empty or very short prompts
  const normalized = firstPrompt.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length < 3) {
    return undefined;
  }

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
        // Best effort — nothing we can do if cleanup fails.
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
  sessionId: string,
  vscodeSessionId: string,
  directory: string | undefined,
): Promise<string | undefined> {
  const logger = state.outputChannel;
  const llmTitle = await generateSessionTitle(prompt, state, sessionId, directory);
  if (llmTitle && !isPlaceholderSessionTitle(llmTitle)) {
    try {
      await state.backend.sessions.update(sessionId, { title: llmTitle, directory });
      const cs = state.sessions.get(vscodeSessionId);
      if (cs && isPlaceholderSessionTitle(cs.title)) {
        cs.title = llmTitle;
      }
      logger.appendLine(`[title-gen] Refreshing session list after LLM title: "${llmTitle}"`);
      state.bus.emit('session-list-changed', void 0);
      logger.appendLine(`[title-gen] Title pushed via sessions.update(): "${llmTitle}"`);
    } catch (updateErr: unknown) {
      const msg = updateErr instanceof Error ? updateErr.message : String(updateErr);
      logger.appendLine(`[title-gen] sessions.update() failed: ${msg}`);
    }
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
function buildTitlePrompt(userMessage: string): string {
  const truncated =
    userMessage.length > 500
      ? `${userMessage.slice(0, 497)}…`
      : userMessage;

  return [
    'Generate a short, descriptive title (2-8 words) for a coding conversation.',
    '',
    'Rules:',
    '- Respond with ONLY the title text — no quotes, no explanation, no punctuation at the end',
    '- The title must capture the main topic or task the user is asking about',
    '- Keep it concise and specific to coding',
    '- Examples: "TypeScript Database Pool" | "React Auth Middleware" | "API Error Handling"',
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
  // Remove formatting artifacts — order matters:
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
