/**
 * Native VS Code Language Model Chat Provider for OpenCode.
 *
 * Registers backend models via `vscode.lm.registerLanguageModelChatProvider` so
 * that VS Code's model picker (and any extension using `vscode.lm.selectChatModels`)
 * can discover and target OpenCode models for the
 * `opencode-copilot.opencode` session type.
 *
 * == Architecture ==
 * ```
 * VS Code model picker / lm.selectChatModels({ vendor: 'opencode' })
 *     │
 *     ▼
 * ┌─────────────────────────────────────────────────┐
 * │  LanguageModelChatProvider (this module)         │
 * │  ┌────────────────────────────────────────────┐ │
 * │  │ provideLanguageModelChatInformation()      │ │
 * │  │ → maps AcpModel[] → LanguageModelChatInfo[]│ │
 * │  └────────────────────────────────────────────┘ │
 * │  ┌────────────────────────────────────────────┐ │
 * │  │ provideLanguageModelChatResponse()         │ │
 * │  │ → streams text from backend prompt API     │ │
 * │  └────────────────────────────────────────────┘ │
 * └─────────────────────────────────────────────────┘
 *     │
 *     ▼
 * state.backend (AcpBackend)
 * ```
 *
 * @module
 */

import * as vscode from 'vscode';
import type { ExtensionState } from '../../types';
import type { AcpEvent, AcpModel } from '../../acp/types';

// ---------------------------------------------------------------------------
// Extended model info carrying backend metadata
// ---------------------------------------------------------------------------

/**
 * Language model information enriched with backend routing data.
 * The extra `provider` / `providerID` fields let us route a chat request
 * to the correct backend model when VS Code invokes `provideLanguageModelChatResponse`.
 */
export interface OpenCodeLanguageModelChatInformation
  extends vscode.LanguageModelChatInformation {
  /** Backend provider ID (e.g. "openai", "anthropic") used for routing */
  readonly providerID: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Vendor identifier used for `vscode.lm.registerLanguageModelChatProvider` */
const VENDOR_ID = 'opencode';
const TARGET_SESSION_TYPE = 'opencode-copilot.opencode';

// ---------------------------------------------------------------------------
// Capability mapping
// ---------------------------------------------------------------------------

/**
 * Map ACP model capabilities to VS Code LanguageModelChatCapabilities.
 *
 * The OpenCode backend SDK returns capability data in two layers:
 *   Top-level keys:  `toolcall` (boolean), `attachment` (boolean), `reasoning`, …
 *   Nested `input`:  `{ text, audio, image, video, pdf }` — each boolean.
 *
 * Image support is determined by `capabilities.input.image === true`
 * (the most precise indicator), falling back to `attachment === true`.
 * Tool calling is `capabilities.toolcall === true`.
 */
function toLmCapabilities(acp: AcpModel): vscode.LanguageModelChatCapabilities {
  const raw = acp.capabilitiesRaw as Record<string, unknown> | undefined;
  if (!raw) {
    return {};
  }

  // Image / vision — prefer `input.image`, fall back to `attachment`.
  let hasImage = false;
  const inputCaps = raw.input as Record<string, unknown> | undefined;
  if (inputCaps && typeof inputCaps.image === 'boolean') {
    hasImage = inputCaps.image === true;
  } else if (typeof raw.attachment === 'boolean') {
    hasImage = raw.attachment === true;
  }

  // Tool calling — `toolcall` boolean.
  const hasTool = raw.toolcall === true;

  return {
    imageInput: hasImage || undefined,
    toolCalling: hasTool || undefined,
  };
}

// ---------------------------------------------------------------------------
// Model → LM information
// ---------------------------------------------------------------------------

/**
 * Convert an AcpModel to an OpenCodeLanguageModelChatInformation.
 *
 * Uses provider + model ID to build a unique-but-stable `id`.
 * Token limits come from the backend's `limit.context` / `limit.output`.
 * If the backend doesn't provide limits, use safe defaults.
 */
function toLmModel(m: AcpModel, isFirst: boolean): OpenCodeLanguageModelChatInformation {
  const providerID = m.provider ?? 'default';
  const caps = toLmCapabilities(m);
  return {
    id: `${providerID}/${m.id}`,
    name: m.name ?? m.id,
    family: m.providerName ?? providerID,
    version: '1',
    // Use real limits from backend or fall back to reasonable defaults.
    maxInputTokens: m.maxInputTokens ?? 128_000,
    maxOutputTokens: m.maxOutputTokens ?? 16_384,
    capabilities: caps,
    targetChatSessionType: TARGET_SESSION_TYPE,
    isUserSelectable: true,
    isDefault: isFirst ? true : undefined,
    providerID,
  };
}

// ---------------------------------------------------------------------------
// Capability check
// ---------------------------------------------------------------------------

/**
 * `true` if `vscode.lm.registerLanguageModelChatProvider` is available.
 * Guards registration at activation time.
 */
export function hasRegisterLanguageModelChatProvider(): boolean {
  return typeof (vscode.lm as Record<string, unknown>).registerLanguageModelChatProvider === 'function';
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/**
 * Create and return a `LanguageModelChatProvider` wired to ExtensionState.
 *
 * The provider:
 * - Fetches models from `state.backend.config.models()`
 * - Maps image capability from backend model capabilities
 * - Streams text responses via the backend event stream
 * - Refreshes on `backend-ready` and `selection-changed` events
 */
export function createLanguageModelChatProvider(
  state: ExtensionState,
): { provider: vscode.LanguageModelChatProvider<OpenCodeLanguageModelChatInformation>; dispose: () => void } {
  const logger = state.outputChannel;
  const onChangeEmitter = new vscode.EventEmitter<void>();

  // Track cached models to avoid unnecessary refresh
  let cachedModels: OpenCodeLanguageModelChatInformation[] = [];

  // Subscribe to bus events that signal model list may have changed
  const unsubBackendReady = state.bus.on('backend-ready', () => {
    onChangeEmitter.fire();
  });
  const provider: vscode.LanguageModelChatProvider<OpenCodeLanguageModelChatInformation> = {
    onDidChangeLanguageModelChatInformation: onChangeEmitter.event,

    async provideLanguageModelChatInformation(
      _options: vscode.PrepareLanguageModelChatModelOptions,
      _token: vscode.CancellationToken,
    ): Promise<OpenCodeLanguageModelChatInformation[]> {
      try {
        if (!state.backend.isRunning()) {
          logger.appendLine('[lm-provider] Backend not running — returning cached/empty model list');
          return cachedModels;
        }

        const result = await state.backend.config.models();
        if (result.error) {
          logger.appendLine(`[lm-provider] Failed to fetch models: ${result.error}`);
          return cachedModels;
        }

        const acpModels = result.data ?? [];
        cachedModels = acpModels.map((m, i) => toLmModel(m, i === 0));

        // Log capability keys present in backend models (for debugging mismatches)
        const allCaps = new Set(acpModels.flatMap((m) => m.capabilities ?? []));
        logger.appendLine(
          `[lm-provider] Reported ${cachedModels.length} models to VS Code. ` +
          `Capability keys seen: [${[...allCaps].join(', ') || 'none'}]`,
        );
        return cachedModels;
      } catch (err) {
        logger.appendLine(`[lm-provider] Error in provideLanguageModelChatInformation: ${err instanceof Error ? err.message : String(err)}`);
        return cachedModels;
      }
    },

    async provideLanguageModelChatResponse(
      model: OpenCodeLanguageModelChatInformation,
      messages: readonly vscode.LanguageModelChatRequestMessage[],
      _options: vscode.ProvideLanguageModelChatResponseOptions,
      progress: vscode.Progress<vscode.LanguageModelResponsePart>,
      token: vscode.CancellationToken,
    ): Promise<void> {
      // Flatten messages into a single text prompt for the backend.
      // A full chat-to-ACP message mapping is out of scope for this PoC;
      // we concatenate text parts to form the user prompt.
      const lastUserMsg = messages[messages.length - 1];
      const textParts: string[] = [];
      if (lastUserMsg) {
        for (const part of lastUserMsg.content) {
          if (part instanceof vscode.LanguageModelTextPart) {
            textParts.push(part.value);
          }
        }
      }
      const promptText = textParts.join('\n');

      if (!promptText) {
        return;
      }

      // Create a temporary session for this request
      const sessionResult = await state.backend.sessions.create({ title: 'LM Provider Chat' });
      if (sessionResult.error || !sessionResult.data) {
        logger.appendLine(`[lm-provider] Failed to create session: ${sessionResult.error}`);
        return;
      }

      const sessionId = sessionResult.data.id;

      // Set up cancellation → abort
      token.onCancellationRequested(() => {
        state.backend.sessions.abort(sessionId).catch(() => { /* best effort */ });
      });

      // Open event stream before sending the prompt
      const eventStream = state.backend.events.openSessionStream(sessionId);

      // Send prompt with model selection from the targeted model info
      await state.backend.sessions.prompt(sessionId, promptText, undefined, {
        model: { providerID: model.providerID, modelID: model.id.split('/').pop() ?? model.id },
      });

      // Stream text events to VS Code via ACP event stream
      try {
        for await (const event of eventStream.stream as AsyncIterable<AcpEvent>) {
          if (token.isCancellationRequested) { break; }

          // Part delta: incremental text from the model
          if (event.type === 'part.delta') {
            progress.report(new vscode.LanguageModelTextPart(event.delta));
          }

          // Part updated with a text part: full/snapshot text (skip if already
          // streaming deltas — deltas are preferred for latency)
          if (event.type === 'part.updated' && event.part.type === 'text' && !event.delta) {
            progress.report(new vscode.LanguageModelTextPart(event.part.text));
          }

          // Session went idle — response complete
          if (event.type === 'session.idle') {
            break;
          }

          // Session error — stop streaming
          if (event.type === 'session.error') {
            logger.appendLine(`[lm-provider] Session error: ${event.error ?? 'unknown'}`);
            break;
          }
        }
      } catch (err) {
        if (token.isCancellationRequested) { return; }
        logger.appendLine(`[lm-provider] Stream error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        state.backend.events.closeSessionStream(sessionId);
      }
    },

    async provideTokenCount(
      _model: OpenCodeLanguageModelChatInformation,
      _text: string | vscode.LanguageModelChatRequestMessage,
      _token: vscode.CancellationToken,
    ): Promise<number> {
      // Rough estimate: ~4 chars per token
      if (typeof _text === 'string') {
        return Math.ceil(_text.length / 4);
      }
      const parts = _text.content;
      let len = 0;
      for (const part of parts) {
        if (part instanceof vscode.LanguageModelTextPart) {
          len += (part as vscode.LanguageModelTextPart).value.length;
        }
      }
      return Math.ceil(len / 4);
    },
  };

  return {
    provider,
    dispose: () => {
      unsubBackendReady();
      onChangeEmitter.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

/**
 * Register the OpenCode language model chat provider if the API is available.
 * Returns the Disposable, or `undefined` if the API is unavailable.
 */
export function registerLanguageModelChatProvider(
  state: ExtensionState,
): vscode.Disposable | undefined {
  if (!hasRegisterLanguageModelChatProvider()) {
    state.outputChannel.appendLine('[lm-provider] vscode.lm.registerLanguageModelChatProvider unavailable — skipping');
    return undefined;
  }

  const { provider, dispose } = createLanguageModelChatProvider(state);
  const registration = vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, provider);

  state.outputChannel.appendLine(`[lm-provider] Registered language model chat provider (vendor="${VENDOR_ID}")`);

  return {
    dispose: () => {
      registration.dispose();
      dispose();
    },
  };
}
