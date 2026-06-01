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
import { streamViaProvider } from './streaming-client';
import { providerRegistry } from '../../acpmodels/provider-registry';
import { AuthReader } from '../../acpmodels/auth-reader';

// ---------------------------------------------------------------------------
// Extended model info carrying backend metadata
// ---------------------------------------------------------------------------

/**
 * Language model information enriched with backend routing data.
 * The extra `providerID` field lets us route a chat request
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

  const unsubSelectionChanged = state.bus.on('selection-changed', () => {
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

        // Use ACPModels exposure list — already filtered to exclude
        // models that Copilot has, and includes OpenCode-unique models.
        const exposed = state.acpModels?.getModelsForExposure() ?? [];
        const entries: OpenCodeLanguageModelChatInformation[] = exposed.map((r, i) => ({
          id: `${r.vendor}/${r.modelId}`,
          name: r.displayName,
          family: r.vendor,
          version: '1',
          maxInputTokens: r.maxInputTokens,
          maxOutputTokens: r.maxOutputTokens,
          capabilities: r.capabilities,
          isUserSelectable: true,
          isDefault: i === 0 ? true : undefined,
          providerID: r.vendor,
        }));

        cachedModels = entries;
        logger.appendLine(
          `[lm-provider] Reported ${cachedModels.length} models from ACPModels exposure list.`,
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
      progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
      token: vscode.CancellationToken,
    ): Promise<void> {
      const bareId = model.id.includes('/') ? model.id.split('/').pop()! : model.id;
      const providerID = model.providerID;

      const providerMeta = providerRegistry.get(providerID);
      if (!providerMeta) {
        error(progress, `Unknown provider "${providerID}"`);
        return;
      }

      // Resolve API key: use "public" for free providers, auth.json for paid ones.
      let apiKey: string | undefined;
      if (isFreeProvider(providerID)) {
        apiKey = 'public';
      } else {
        const authReader = new AuthReader();
        await authReader.load();
        apiKey = authReader.getApiKey(providerID);
      }

      if (!apiKey) {
        error(progress, `No API key configured for provider "${providerID}". Add it via \`opencode /connect ${providerID}\` or set the ${providerID.toUpperCase()}_API_KEY environment variable.`);
        return;
      }

      logger.appendLine(`[lm-provider] Streaming via ${providerMeta.npm} ${providerMeta.baseURL} model="${bareId}"`);

      try {
        await streamViaProvider({
          providerMeta,
          apiKey,
          modelId: bareId,
          messages,
          tools: _options.tools,
          progress,
          token,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.appendLine(`[lm-provider] Provider stream error: ${msg}`);
        error(progress, `Provider error: ${msg}`);
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
      unsubSelectionChanged();
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

// ── Helpers ────────────────────────────────────────────────────

/** Providers that use "public" auth (free tier, no key required) */
function isFreeProvider(providerID: string): boolean {
  return providerID === 'opencode' || providerID === 'ollama';
}

function error(progress: vscode.Progress<vscode.LanguageModelResponsePart>, msg: string): void {
  progress.report(new vscode.LanguageModelTextPart(`❌ ${msg}`));
}
