import * as vscode from 'vscode';
import type { AcpBackend } from './acp/backend';
import type { AcpAgent, AcpModel, AcpConfig, AcpProviderConfig, BackendSettingsDescriptor } from './acp/types';
import { OpenCodeBackend } from './backends/opencode/adapter';
import { createParticipantHandler } from './participant/handler';
import { createSessionContentProvider, OPENCODE_SESSION_SCHEME } from './surfaces/vscode/experimental-session';
import { hasRegisterChatSessionContentProvider } from './surfaces/vscode/capabilities';
import { StatusBarManager } from './statusbar';
import { SettingsPanel, type SettingsMessage, type SettingsData } from './settings/panel';
import { hydrateStateFromPersisted, savePersistedSettingsState, extractPersistedState } from './settings/state-persistence';
import type { ExtensionState } from './types';

const KNOWN_PROVIDERS = [
  { id: 'openai', name: 'OpenAI', description: 'GPT-4o, GPT-4o-mini', requiresBaseURL: false, isOpenAICompatible: false, icon: '\ud83d\udfe2' },
  { id: 'anthropic', name: 'Anthropic', description: 'Claude 3.5 Sonnet, Opus', requiresBaseURL: false, isOpenAICompatible: false, icon: '\ud83d\udfe0' },
  { id: 'google', name: 'Google', description: 'Gemini Pro, Flash', requiresBaseURL: false, isOpenAICompatible: false, icon: '\ud83d\udfe1' },
  { id: 'groq', name: 'Groq', description: 'Fast inference', requiresBaseURL: false, isOpenAICompatible: false, icon: '\u26a1' },
  { id: 'xai', name: 'xAI', description: 'Grok models', requiresBaseURL: false, isOpenAICompatible: false, icon: '\ud83c\udf11' },
  { id: 'mistral', name: 'Mistral', description: 'Mistral, Codestral', requiresBaseURL: false, isOpenAICompatible: false, icon: '\ud83d\udd34' },
  { id: 'deepseek', name: 'DeepSeek', description: 'DeepSeek V3, Coder', requiresBaseURL: false, isOpenAICompatible: false, icon: '\ud83d\udc33' },
  { id: 'together', name: 'Together AI', description: 'Open model hub', requiresBaseURL: false, isOpenAICompatible: false, icon: '\ud83d\udfe3' },
  { id: 'fireworks', name: 'Fireworks AI', description: 'Fast inference', requiresBaseURL: false, isOpenAICompatible: false, icon: '\ud83c\udf86' },
  { id: 'bedrock', name: 'AWS Bedrock', description: 'Managed models', requiresBaseURL: false, isOpenAICompatible: false, icon: '\u2601\ufe0f' },
  { id: 'azure', name: 'Azure OpenAI', description: 'Azure-hosted OpenAI', requiresBaseURL: true, isOpenAICompatible: false, icon: '\ud83d\udd37' },
  { id: 'copilot', name: 'GitHub Copilot', description: 'Copilot models', requiresBaseURL: false, isOpenAICompatible: false, icon: '\ud83d\udc19' },
  { id: 'ollama', name: 'Ollama', description: 'Local models', requiresBaseURL: true, isOpenAICompatible: false, icon: '\ud83e\udd99' },
  { id: 'openrouter', name: 'OpenRouter', description: 'Multi-model gateway', requiresBaseURL: false, isOpenAICompatible: false, icon: '\ud83c\udf10' },
  { id: 'openai-compatible', name: 'OpenAI Compatible', description: 'Any OpenAI-compatible endpoint', requiresBaseURL: true, isOpenAICompatible: true, icon: '\ud83d\udd0c' },
];

function getWorkspaceDirectory(): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  return workspaceFolders?.[0]?.uri?.fsPath;
}

let state: ExtensionState | undefined;

function createBackend(): AcpBackend {
  return new OpenCodeBackend();
}

function getBackendDisplayName(backendName: string): string {
  if (backendName === 'opencode') {return 'OpenCode';}
  if (!backendName) {return '--';}
  return backendName.charAt(0).toUpperCase() + backendName.slice(1);
}

/** Refresh status bar items from the current state */
async function refreshStatusBar(s: ExtensionState): Promise<void> {
  try {
    const agentName = s.currentAgent ?? '--';
    let modelName = s.currentModelDisplayName ?? '--';

    if (!s.currentModelDisplayName && s.currentModel) {
      modelName = s.currentModel.modelID;
    }

    s.statusBar.update({
      backendName: getBackendDisplayName(s.backend.name),
      agentName,
      modelName,
      isBackendActive: s.backend.isRunning(),
    });
  } catch {
    // non-critical
  }
}

/** Load default agent/model from backend config and update state */
async function loadDefaultsFromConfig(s: ExtensionState): Promise<void> {
  try {
    const [configResult, agentsResult] = await Promise.all([
      s.backend.config.get(),
      s.backend.config.agents(),
    ]);

    if (configResult.data) {
      const cfg = configResult.data;

      // Validate persisted model against available models. If the persisted
      // model no longer exists (e.g. backend config changed), clear it so
      // the fallback logic below can find a suitable replacement.
      if (s.currentModel) {
        const modelsResp = await s.backend.config.models();
        const models = modelsResp.data ?? [];
        const modelStillValid = models.some(m => m.id === s.currentModel!.modelID);
        if (!modelStillValid) {
          s.outputChannel.appendLine(
            `[extension] Persisted model "${s.currentModel.modelID}" not found in backend model list — clearing`,
          );
          s.currentModel = undefined;
          s.currentModelDisplayName = undefined;
        }
      }

      if (!s.currentAgent && cfg.default_agent) {
        s.currentAgent = cfg.default_agent;
      }
      if (!s.currentModel && cfg.model) {
        // Try to find provider for the default model
        const modelsResp = await s.backend.config.models();
        const models = modelsResp.data ?? [];
        const match = models.find(m => m.id === cfg.model);
        if (match) {
          s.currentModel = {
            providerID: match.provider ?? '',
            modelID: match.id,
          };
          s.currentModelDisplayName = match.name ?? match.id;
        }
      }
    }

    // If still no agent, use first available primary agent
    if (!s.currentAgent && agentsResult.data) {
      const primary = agentsResult.data.find(a => a.mode === 'primary' && !a.hidden);
      if (primary) {
        s.currentAgent = primary.id;
      }
    }

    // If still no model, try current agent's model or agent config override
    if (!s.currentModel && s.currentAgent) {
      // Try agent's model field (may be string or {modelID, providerID} object)
      const agentData = (agentsResult.data ?? []).find((a: AcpAgent) => a.id === s.currentAgent);
      let modelId: string | undefined;
      let providerId: string | undefined;

      const rawModel = agentData?.model;
      if (typeof rawModel === 'object' && rawModel !== null) {
        modelId = rawModel.modelID;
        providerId = rawModel.providerID;
      } else if (typeof rawModel === 'string') {
        modelId = rawModel;
      }

      // Try agent config override
      if (!modelId && configResult.data?.agent) {
        const agentCfg = configResult.data.agent[s.currentAgent];
        if (typeof agentCfg?.model === 'string') {
          modelId = agentCfg.model;
        }
      }

      if (modelId) {
        // Try to resolve display name from models list
        try {
          const modelsResp = await s.backend.config.models();
          const models = modelsResp.data ?? [];
          let match = models.find((m: AcpModel) => m.id === modelId);
          if (!match) {
            match = models.find((m: AcpModel) => m.id.includes(modelId) || modelId.includes(m.id));
          }
          if (match) {
            s.currentModel = { providerID: providerId ?? match.provider ?? '', modelID: match.id };
            s.currentModelDisplayName = match.name ?? match.id;
          } else {
            s.currentModel = { providerID: providerId ?? '', modelID: modelId };
            s.currentModelDisplayName = modelId;
          }
        } catch {
          s.currentModel = { providerID: providerId ?? '', modelID: modelId };
          s.currentModelDisplayName = modelId;
        }
      }
    }

    await refreshStatusBar(s);
  } catch (err) {
    s.outputChannel.appendLine(
      `[extension] loadDefaultsFromConfig error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('OpenCode Copilot');
  outputChannel.appendLine('[extension] OpenCode Copilot activating...');

  const backend = createBackend();
  const statusBar = new StatusBarManager();

  state = {
    backend,
    outputChannel,
    sessionMap: new Map(),
    statusBar,
  };

  // Hydrate persistent settings BEFORE backend starts so loadDefaultsFromConfig
  // sees the persisted values and won't overwrite them with config defaults.
  hydrateStateFromPersisted(context, state);

  // Start backend immediately on activation
  const workspacePath = getWorkspaceDirectory();
  backend.start(workspacePath).then(async (result) => {
    if (result.error) {
      outputChannel.appendLine(`[extension] Backend start failed: ${String(result.error)}`);
      statusBar.updateError(backend.name);
      return;
    }
    outputChannel.appendLine(`[extension] Backend started at ${result.data?.url}`);
    // Load default agent/model from config and update status bar
    await loadDefaultsFromConfig(state!);
    // Persist whatever loadDefaultsFromConfig resolved (e.g. backend defaults
    // when there's no persisted override yet).
    savePersistedSettingsState(context, extractPersistedState(state!));
    // Notify session provider that backend is ready so it can refresh
    // option groups and session list (avoids polling while offline).
    state!.onBackendReady?.();
  }).catch((err: unknown) => {
    outputChannel.appendLine(
      `[extension] Backend start error: ${err instanceof Error ? err.message : String(err)}`,
    );
    statusBar.updateError(backend.name);
  });

  // Register the settings panel command
  const openSettingsCommand = vscode.commands.registerCommand(
    'opencode.openSettings',
    async () => {
      const panel = SettingsPanel.createOrShow(context.extensionUri);

      // Wire up message handler
      panel.onDidRequestChange = async (message: SettingsMessage) => {
        if (!state) {return;}

        try {
          switch (message.type) {
            case 'ready': {
              // Webview is ready — push current data
              await pushDataToPanel(state, panel);
              break;
            }
            case 'refreshData': {
              await pushDataToPanel(state, panel);
              break;
            }
            case 'setAgent': {
              state.currentAgent = message.agentId;
              savePersistedSettingsState(context, extractPersistedState(state));
              await refreshStatusBar(state);
              await pushDataToPanel(state, panel);
              break;
            }
            case 'setModel': {
              state.currentModel = {
                providerID: message.providerID,
                modelID: message.modelID,
              };
              {
                const modelsResp = await state.backend.config.models().catch(() => ({ data: [] as AcpModel[] }));
                const match = (modelsResp.data ?? []).find(m => m.id === message.modelID && m.provider === message.providerID);
                state.currentModelDisplayName = match?.name ?? message.modelID;
              }
              savePersistedSettingsState(context, extractPersistedState(state));
              await refreshStatusBar(state);
              await pushDataToPanel(state, panel);
              break;
            }
            case 'setDefaultAgent': {
              await state.backend.config.update({
                default_agent: message.agent || undefined,
              });
              await pushDataToPanel(state, panel);
              break;
            }
            case 'setDefaultModel': {
              await state.backend.config.update({
                model: message.model || undefined,
              });
              await pushDataToPanel(state, panel);
              break;
            }
            case 'saveBackendSettings': {
              if (state.backend.settingsProvider) {
                await state.backend.settingsProvider.saveValues(message.values);
              }
              await pushDataToPanel(state, panel);
              break;
            }
            case 'connectProvider': {
              const known = KNOWN_PROVIDERS.find(p => p.id === message.providerId);
              const apiType = message.providerId === 'openai-compatible' ? 'openai' : message.providerId;
              const providerConfig: AcpProviderConfig = {
                api: apiType,
                id: message.providerId,
                name: message.displayName || known?.name || message.providerId,
                options: {
                  apiKey: message.apiKey,
                  ...(message.baseURL ? { baseURL: message.baseURL } : {}),
                },
              };
              const configKey = message.providerId === 'openai-compatible'
                ? (message.displayName?.toLowerCase().replace(/[^a-z0-9]/g, '-') || 'custom-' + Date.now())
                : message.providerId;
              await state.backend.config.update({
                provider: { [configKey]: providerConfig },
              });
              await pushDataToPanel(state, panel);
              break;
            }
            case 'disconnectProvider': {
              const currentConfig = await state.backend.config.get();
              const currentProviders = { ...(currentConfig.data?.provider ?? {}) };
              delete currentProviders[message.configKey];
              await state.backend.config.update({
                provider: currentProviders,
              });
              await pushDataToPanel(state, panel);
              break;
            }
            case 'updateProvider': {
              const currentCfg = await state.backend.config.get();
              const existing = currentCfg.data?.provider?.[message.configKey];
              const updateConfig: AcpProviderConfig = {
                options: {
                  apiKey: message.apiKey,
                  ...(message.baseURL ? { baseURL: message.baseURL } : {}),
                },
              };
              if (existing?.id) { updateConfig.id = existing.id; }
              if (existing?.name) { updateConfig.name = existing.name; }
              if (existing?.api) { updateConfig.api = existing.api; }
              await state.backend.config.update({
                provider: { [message.configKey]: updateConfig },
              });
              await pushDataToPanel(state, panel);
              break;
            }
          }
        } catch (err) {
          outputChannel.appendLine(
            `[settings] Error handling message: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      };

      // Push initial data
      if (!state) {return;}
      await pushDataToPanel(state, panel);
    },
  );

  const participant = vscode.chat.createChatParticipant(
    'opencode-copilot.opencode',
    createParticipantHandler(state),
  );
  participant.iconPath = new vscode.ThemeIcon('terminal');

  participant.onDidReceiveFeedback((feedback: vscode.ChatResultFeedback) => {
    outputChannel.appendLine(
      `[feedback] ${feedback.kind === vscode.ChatResultFeedbackKind.Helpful ? '👍' : '👎'}`,
    );
  });

  if (hasRegisterChatSessionContentProvider()) {
    const { provider, controller } = createSessionContentProvider(state, context);
    const registration = vscode.chat.registerChatSessionContentProvider(
      OPENCODE_SESSION_SCHEME,
      provider,
      participant,
      { supportsChangingSessionType: true },
    );

    context.subscriptions.push(registration);
    if (controller) {
      outputChannel.appendLine(`[extension] Session content provider registered (controller id=${controller.id}) — OpenCode appears in Session Target dropdown`);
    } else {
      outputChannel.appendLine('[extension] Session content provider registered (no controller — picker changes will NOT propagate) — OpenCode appears in Session Target dropdown');
    }
  } else {
    outputChannel.appendLine('[extension] chatSessionsProvider API unavailable — session target registration skipped');
  }

  context.subscriptions.push(outputChannel, participant, statusBar, openSettingsCommand);
  outputChannel.appendLine('[extension] OpenCode Copilot activated');
}

function maskApiKey(key: string): string {
  if (key.length <= 8) return '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
  return key.slice(0, 4) + '\u2022\u2022\u2022\u2022' + key.slice(-4);
}

function computeConnectedProviders(
  config: { provider?: Record<string, AcpProviderConfig> },
  models: AcpModel[],
): SettingsData['connectedProviders'] {
  const result: SettingsData['connectedProviders'] = [];
  const seen = new Set<string>();

  // 1) Explicit provider entries from config.provider (user-configured with API keys)
  const explicitProviders = config.provider ?? {};
  for (const [key, value] of Object.entries(explicitProviders)) {
    if (seen.has(key)) continue;
    seen.add(key);
    const apiKey = value.options?.apiKey;
    result.push({
      configKey: key,
      id: value.id || value.api || key,
      name: value.name || key,
      hasApiKey: Boolean(apiKey),
      apiKeyPreview: apiKey ? maskApiKey(apiKey) : undefined,
      baseURL: value.options?.baseURL,
    });
  }

  // 2) Providers discovered from models (populated by SDK from env vars / auth)
  for (const m of models) {
    const pid = m.provider;
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    result.push({
      configKey: pid,
      id: pid,
      name: m.providerName || pid,
      hasApiKey: true, // If models show up, the provider is authenticated
      baseURL: undefined,
    });
  }

  return result;
}

/** Push current backend data into the settings webview panel */
async function pushDataToPanel(s: ExtensionState, panel: SettingsPanel): Promise<void> {
  try {
    const [agentsResp, modelsResp, configResp] = await Promise.all([
      s.backend.config.agents().catch(() => ({ data: [] as AcpAgent[] })),
      s.backend.config.models().catch(() => ({ data: [] as AcpModel[] })),
      s.backend.config.get().catch(() => ({ data: undefined })),
    ]);

    const agents = agentsResp.data ?? [];
    const models = modelsResp.data ?? [];
    const config = configResp.data ?? {};

    // Get backend settings descriptor if provider exists
    let backendSettings: BackendSettingsDescriptor | undefined;
    if (s.backend.settingsProvider) {
      try {
        backendSettings = await s.backend.settingsProvider.getDescriptor(agents, models);
      } catch {
        // non-critical — backend settings UI will show empty state
      }
    }

    const data: SettingsData = {
      backendName: getBackendDisplayName(s.backend.name),
      agents: agents.map(a => ({
        id: a.id,
        name: a.name,
        description: a.description,
        model: typeof (a).model === 'object' && (a).model !== null
          ? ((a).model.modelID ?? String((a).model))
          : a.model,
        mode: a.mode,
        hidden: a.hidden,
      })),
      models: models.map(m => ({
        id: m.id,
        name: m.name,
        provider: m.providerName ?? m.provider,
        providerId: m.provider,
        capabilities: m.capabilities,
      })),
      currentAgent: s.currentAgent,
      currentModel: s.currentModel,
      currentModelDisplayName: s.currentModelDisplayName,
      defaultAgent: config.default_agent,
      defaultModel: config.model,
      backendSettings,
      connectedProviders: computeConnectedProviders(config, models),
      availableProviders: KNOWN_PROVIDERS,
    };

    // Try to resolve currentModel from: 1) state, 2) config.model, 3) agent's model
    if (!s.currentModel) {
      let resolvedModelId: string | undefined;
      let resolvedProvider: string | undefined;

      // Strategy 2: from config.model
      if (config.model) {
        resolvedModelId = config.model;
      }

      // Strategy 3: from current agent's model field (may be string or object)
      if (!resolvedModelId && s.currentAgent) {
        const agentData = agents.find((a: AcpAgent) => a.id === s.currentAgent);
        const rawModel = agentData?.model;
        if (typeof rawModel === 'object' && rawModel !== null) {
          resolvedModelId = rawModel.modelID;
          resolvedProvider = rawModel.providerID;
        } else if (typeof rawModel === 'string') {
          resolvedModelId = rawModel;
        }
      }

      // Strategy 4: from agent config override
      if (!resolvedModelId && s.currentAgent) {
        const agentConfig = config.agent?.[s.currentAgent];
        if (agentConfig?.model) {
          resolvedModelId = agentConfig.model;
        }
      }

      if (resolvedModelId) {
        // Try exact match first, then contains match
        let match = models.find((m: AcpModel) => m.id === resolvedModelId);
        if (!match) {
          match = models.find((m: AcpModel) => m.id.includes(resolvedModelId) || resolvedModelId.includes(m.id));
        }
        if (match) {
          s.currentModel = {
            providerID: match.provider ?? '',
            modelID: match.id,
          };
          s.currentModelDisplayName = match.name ?? match.id;
          data.currentModel = s.currentModel;
          data.currentModelDisplayName = s.currentModelDisplayName;
        } else {
          // Model not found in list — still set it as raw value for display
          s.currentModel = { providerID: '', modelID: resolvedModelId };
          s.currentModelDisplayName = resolvedModelId;
          data.currentModel = s.currentModel;
          data.currentModelDisplayName = s.currentModelDisplayName;
        }
      }
    }

    s.outputChannel.appendLine(`[settings] pushDataToPanel: currentModel=${JSON.stringify(s.currentModel)}, currentModelDisplayName=${s.currentModelDisplayName}, configModel=${config.model}, currentAgent=${s.currentAgent}`);
    s.outputChannel.appendLine(`[settings] pushDataToPanel: models count=${data.models.length}, model IDs=${data.models.map((m) => m.id + '(' + m.providerId + ')').join(', ')}`);
    s.outputChannel.appendLine(`[settings] pushDataToPanel: agents=${data.agents.map((a) => a.id + ':model=' + (a.model ?? 'none')).join(', ')}`);

    panel.updateData(data);
  } catch {
    // non-critical
  }
}

export function deactivate() {
  if (state) {
    state.outputChannel.appendLine('[extension] Deactivating...');
    if (state.backend.isRunning()) {
      state.backend.stop().catch((err: unknown) => {
        state!.outputChannel.appendLine(
          `[extension] Stop error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }
}
