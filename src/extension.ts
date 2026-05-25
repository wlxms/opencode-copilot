import * as vscode from 'vscode';
import type { AcpBackend } from './acp/backend';
import { OpenCodeBackend } from './backends/opencode/adapter';
import { createParticipantHandler } from './participant/handler';
import { createSessionContentProvider } from './surfaces/vscode/experimental-session';
import { hasRegisterChatSessionContentProvider } from './surfaces/vscode/capabilities';
import { StatusBarManager } from './statusbar';
import { SettingsPanel, type SettingsMessage, type SettingsData } from './settings/panel';
import type { ExtensionState } from './types';

function getWorkspaceDirectory(): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  return workspaceFolders?.[0]?.uri?.fsPath;
}

let state: ExtensionState | undefined;

function isExperimentalSessionProviderEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('opencode')
    .get<boolean>('experimental.sessionProvider', false);
}

function createBackend(): AcpBackend {
  return new OpenCodeBackend();
}

function getBackendDisplayName(backendName: string): string {
  if (backendName === 'opencode') return 'OpenCode';
  if (!backendName) return '--';
  return backendName.charAt(0).toUpperCase() + backendName.slice(1);
}

/** Refresh status bar items from the current state */
async function refreshStatusBar(s: ExtensionState): Promise<void> {
  try {
    let agentName = s.currentAgent ?? '--';
    let modelName = s.currentModelDisplayName ?? '--';

    if (!s.currentModelDisplayName && s.currentModel) {
      modelName = s.currentModel.modelID;
    }

    s.statusBar.update({
      backendName: getBackendDisplayName(s.backend.name),
      agentName,
      modelName,
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

    await refreshStatusBar(s);
  } catch {
    // non-critical — defaults will be loaded on first server start
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

  // Start backend immediately on activation
  const workspacePath = getWorkspaceDirectory();
  backend.start(workspacePath).then((result) => {
    if (result.error) {
      outputChannel.appendLine(`[extension] Backend start failed: ${String(result.error)}`);
      statusBar.updateBackend(`${backend.name} (error)`);
      return;
    }
    outputChannel.appendLine(`[extension] Backend started at ${result.data?.url}`);
    // Load default agent/model from config and update status bar
    loadDefaultsFromConfig(state!);
  }).catch((err: unknown) => {
    outputChannel.appendLine(
      `[extension] Backend start error: ${err instanceof Error ? err.message : String(err)}`,
    );
    statusBar.updateBackend(`${backend.name} (error)`);
  });

  // Register the settings panel command
  const openSettingsCommand = vscode.commands.registerCommand(
    'opencode.openSettings',
    async () => {
      const panel = SettingsPanel.createOrShow(context.extensionUri);

      // Wire up message handler
      panel.onDidRequestChange = async (message: SettingsMessage) => {
        if (!state) return;

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
              state.selectedAgentOverride = message.agentId;
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
                const modelsResp = await state.backend.config.models().catch(() => ({ data: [] as any[] }));
                const match = (modelsResp.data ?? []).find(m => m.id === message.modelID && m.provider === message.providerID);
                state.currentModelDisplayName = match?.name ?? message.modelID;
              }
              state.selectedModelOverride = {
                providerID: message.providerID,
                modelID: message.modelID,
              };
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
            case 'updateConfig': {
              await state.backend.config.update(message.config as any);
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

  if (isExperimentalSessionProviderEnabled()) {
    if (hasRegisterChatSessionContentProvider()) {
      const chat = vscode.chat as typeof vscode.chat & {
        registerChatSessionContentProvider?: (
          sessionType: string,
          provider: unknown,
        ) => vscode.Disposable;
      };

      const provider = createSessionContentProvider(state, context);
      const registration = chat.registerChatSessionContentProvider?.(
        'opencode-copilot.opencode',
        provider,
      );

      if (registration) {
        context.subscriptions.push(registration);
        outputChannel.appendLine('[extension] Experimental session provider registered');
      } else {
        outputChannel.appendLine('[extension] Experimental session provider requested but unavailable at runtime');
      }
    } else {
      outputChannel.appendLine('[extension] Experimental session provider enabled, but VS Code API is unavailable');
    }
  }

  context.subscriptions.push(outputChannel, participant, statusBar, openSettingsCommand);
  outputChannel.appendLine('[extension] OpenCode Copilot activated');
}

/** Push current backend data into the settings webview panel */
async function pushDataToPanel(s: ExtensionState, panel: SettingsPanel): Promise<void> {
  try {
    const [agentsResp, modelsResp, configResp] = await Promise.all([
      s.backend.config.agents().catch(() => ({ data: [] as any[] })),
      s.backend.config.models().catch(() => ({ data: [] as any[] })),
      s.backend.config.get().catch(() => ({ data: undefined as any })),
    ]);

    const data: SettingsData = {
      backendName: getBackendDisplayName(s.backend.name),
      agents: (agentsResp.data ?? []).map(a => ({
        id: a.id,
        name: a.name,
        description: a.description,
        model: a.model,
        mode: a.mode,
        hidden: a.hidden,
      })),
      models: (modelsResp.data ?? []).map(m => ({
        id: m.id,
        name: m.name,
        provider: m.providerName ?? m.provider,
        providerId: m.provider,
        capabilities: m.capabilities,
      })),
      currentAgent: s.currentAgent,
      currentModel: s.currentModel,
      currentModelDisplayName: s.currentModelDisplayName,
      config: configResp.data ?? {},
    };

    if (!s.currentModel && configResp.data?.model) {
      const match = (modelsResp.data ?? []).find(m => m.id === configResp.data?.model);
      if (match) {
        s.currentModel = {
          providerID: match.provider ?? '',
          modelID: match.id,
        };
        s.currentModelDisplayName = match.name ?? match.id;
        data.currentModel = s.currentModel;
      }
    }

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
