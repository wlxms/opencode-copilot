import * as vscode from 'vscode';
import type { BackendSettingsDescriptor } from '../acp/types';

export type SettingsMessage =
  | { type: 'ready' }
  | { type: 'refreshData' }
  | { type: 'setAgent'; agentId: string }
  | { type: 'setModel'; providerID: string; modelID: string }
  | { type: 'setDefaultModel'; model: string }
  | { type: 'setDefaultAgent'; agent: string }
  | { type: 'saveBackendSettings'; values: Record<string, unknown> }
| { type: 'connectProvider'; providerId: string; apiKey: string; baseURL?: string; displayName?: string }
| { type: 'disconnectProvider'; configKey: string }
| { type: 'updateProvider'; configKey: string; apiKey: string; baseURL?: string };

export interface SettingsData {
  backendName: string;
  agents: Array<{ id: string; name?: string; description?: string; model?: string; mode?: string; hidden?: boolean }>;
  models: Array<{ id: string; name?: string; provider?: string; providerId?: string; capabilities?: string[] }>;
  currentAgent?: string;
  currentModel?: { providerID: string; modelID: string };
  currentModelDisplayName?: string;
  /** Default agent from backend config */
  defaultAgent?: string;
  /** Default model from backend config */
  defaultModel?: string;
  /** Backend-specific settings descriptor (pluggable per backend) */
  backendSettings?: BackendSettingsDescriptor;
  /** Connected providers with masked API key info */
  connectedProviders: Array<{
    configKey: string;
    id: string;
    name: string;
    hasApiKey: boolean;
    apiKeyPreview?: string;
    baseURL?: string;
  }>;
  /** All supported provider definitions */
  availableProviders: Array<{
    id: string;
    name: string;
    description: string;
    requiresBaseURL: boolean;
    isOpenAICompatible: boolean;
    icon: string;
  }>;
}

export class SettingsPanel {
  public static currentPanel: SettingsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  public static readonly viewType = 'opencodeSettings';

  public static createOrShow(_extensionUri: vscode.Uri): SettingsPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (SettingsPanel.currentPanel) {
      SettingsPanel.currentPanel.panel.reveal(column);
      return SettingsPanel.currentPanel;
    }

    SettingsPanel.currentPanel = new SettingsPanel(column);
    return SettingsPanel.currentPanel;
  }

  private constructor(column?: vscode.ViewColumn) {
    this.panel = vscode.window.createWebviewPanel(
      SettingsPanel.viewType,
      'ACP Settings',
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    this.panel.iconPath = new vscode.ThemeIcon('gear');
    this.panel.webview.html = this.getHtml();

    this.panel.onDidDispose(() => { this.dispose(); }, null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: SettingsMessage) => { this.handleMessage(message); },
      null,
      this.disposables,
    );
  }

  public updateData(data: SettingsData): void {
    void this.panel.webview.postMessage({ type: 'updateData', data });
  }

  public onDidRequestChange: ((message: SettingsMessage) => void) | undefined;

  private handleMessage(message: SettingsMessage): void {
    this.onDidRequestChange?.(message);
  }

  private dispose(): void {
    SettingsPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ACP Settings</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --card: var(--vscode-editorWidget-background);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border);
      --accent: var(--vscode-button-background);
      --accent-hover: var(--vscode-button-hoverBackground);
      --accent-fg: var(--vscode-button-foreground);
      --focus: var(--vscode-focusBorder);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px 32px 32px;
      font-family: var(--vscode-font-family);
      background: var(--bg);
      color: var(--fg);
      font-size: 13px;
      line-height: 1.5;
    }
    h1 { margin: 0 0 6px; font-size: 22px; font-weight: 600; }
    h2 { margin: 0; font-size: 13px; text-transform: uppercase; letter-spacing: .3px; color: var(--accent); }
    h3 { margin: 0 0 10px; font-size: 14px; font-weight: 600; }
    .subtitle { margin: 0 0 18px; color: var(--muted); }
    .tabs, .subtabs {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--border);
      margin-bottom: 18px;
    }
    .tab, .subtab {
      padding: 8px 16px;
      cursor: pointer;
      color: var(--muted);
      border-bottom: 2px solid transparent;
      user-select: none;
    }
    .tab.active, .subtab.active { color: var(--fg); border-bottom-color: var(--accent); }
    .hidden { display: none !important; }
    .section { margin-top: 24px; }
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 12px;
    }
    .field { margin-bottom: 12px; }
    .field:last-child { margin-bottom: 0; }
    .field label { display: block; margin-bottom: 4px; font-size: 12px; font-weight: 600; }
    .desc { color: var(--muted); font-size: 11px; margin-bottom: 6px; }
    select, input[type="text"] {
      width: 100%;
      padding: 7px 9px;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 6px;
      outline: none;
      font: inherit;
    }
    select:focus, input:focus { border-color: var(--focus); }
    button {
      padding: 7px 14px;
      background: var(--accent);
      color: var(--accent-fg);
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font: inherit;
    }
    button:hover { background: var(--accent-hover); }
    .button-secondary {
      background: transparent;
      color: var(--fg);
      border: 1px solid var(--border);
    }
    .button-secondary:hover { background: var(--input-bg); }
    .backend-target { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .backend-target-main { display: flex; align-items: center; gap: 12px; }
    .backend-badge {
      width: 40px; height: 40px; border-radius: 10px; background: var(--accent); color: var(--accent-fg);
      display: flex; align-items: center; justify-content: center; font-weight: 700;
    }
    .backend-meta { color: var(--muted); font-size: 11px; }
    .session-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .session-grid > .card { display: flex; flex-direction: column; margin-bottom: 0; }
    .list-card-item {
      padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 8px; cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .list-card-item:hover {
      background: color-mix(in srgb, var(--fg) 6%, transparent);
      border-color: color-mix(in srgb, var(--fg) 15%, transparent);
    }
    .list-card-item.selected {
      border-color: color-mix(in srgb, var(--fg) 25%, transparent);
      background: color-mix(in srgb, var(--fg) 8%, transparent);
    }
    .list-card-item.selected:hover {
      background: color-mix(in srgb, var(--fg) 12%, transparent);
      border-color: color-mix(in srgb, var(--fg) 35%, transparent);
    }
    .item-title { font-weight: 600; }
    .item-meta { color: var(--muted); font-size: 11px; }
    .provider-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .provider-card { padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--input-bg); }
    .modal-backdrop {
      position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 10;
    }
    .modal { width: min(560px, calc(100vw - 32px)); background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 18px; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
    .empty-state {
      color: var(--muted); padding: 18px; border: 1px dashed var(--border); border-radius: 8px; text-align: center;
    }
    .dropdown-container { position: relative; width: 100%; }
    .dropdown-trigger { display: flex; justify-content: space-between; align-items: center; width: 100%; padding: 10px 12px; background: var(--input-bg); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; color: var(--fg); text-align: left; transition: background 0.15s ease, border-color 0.15s ease; }
    .dropdown-trigger:hover { background: color-mix(in srgb, var(--fg) 6%, transparent); border-color: color-mix(in srgb, var(--fg) 15%, transparent); }
    .dropdown-trigger .item-title { font-weight: 600; font-size: 13px; }
    .dropdown-trigger .item-meta { color: var(--muted); font-size: 11px; }
    .dropdown-trigger-icon { margin-left: 8px; color: var(--muted); font-size: 10px; }
    .dropdown-panel { position: absolute; top: 100%; left: 0; right: 0; margin-top: 4px; background: var(--card); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); max-height: 250px; overflow-y: auto; z-index: 100; padding: 8px; display: none; }
    .dropdown-panel.open { display: block; }
    .dropdown-panel .list-card-item { margin-bottom: 4px; }
    .dropdown-panel .list-card-item:last-child { margin-bottom: 0; }
    @media (max-width: 900px) { .session-grid { grid-template-columns: 1fr; } }

    /* Provider management styles */
    .provider-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
    .provider-item {
      padding: 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--input-bg);
      cursor: pointer; transition: background 0.15s ease, border-color 0.15s ease;
      display: flex; flex-direction: column; gap: 6px;
    }
    .provider-item:hover {
      background: color-mix(in srgb, var(--fg) 6%, transparent);
      border-color: color-mix(in srgb, var(--fg) 15%, transparent);
    }
    .provider-item-header { display: flex; align-items: center; justify-content: space-between; }
    .provider-item-name { font-weight: 600; font-size: 13px; }
    .provider-item-status {
      font-size: 10px; padding: 2px 6px; border-radius: 4px;
      background: color-mix(in srgb, var(--accent) 20%, transparent);
      color: var(--accent); font-weight: 600;
    }
    .provider-item-actions { display: flex; gap: 6px; margin-top: 4px; }
    .provider-item-actions button { font-size: 11px; padding: 3px 8px; }
    .provider-add-btn {
      width: 28px; height: 28px; border-radius: 6px; border: 1px solid var(--border);
      background: transparent; color: var(--fg); cursor: pointer; font-size: 16px;
      display: flex; align-items: center; justify-content: center; line-height: 1;
    }
    .provider-add-btn:hover { background: var(--input-bg); border-color: var(--accent); }
    .provider-grid-add { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin-bottom: 16px; }
    .provider-option {
      padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--input-bg);
      cursor: pointer; text-align: center; transition: all 0.15s ease;
    }
    .provider-option:hover {
      border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent);
    }
    .provider-option.selected {
      border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent);
    }
    .provider-option-name { font-weight: 600; font-size: 12px; }
    .provider-option-desc { color: var(--muted); font-size: 10px; margin-top: 2px; }
    .provider-form { margin-top: 16px; }
    .provider-form .field { margin-bottom: 10px; }
    .provider-form input { width: 100%; }
    .provider-form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  </style>
</head>
<body>
  <h1>ACP Settings</h1>
  <p class="subtitle">Configure backend, agent, model, and backend-specific options.</p>

  <div class="tabs">
    <div class="tab active" data-tab="backend">Backend</div>
    <div class="tab" data-tab="global">Global Setting</div>
  </div>

  <section id="tab-backend" class="tab-content">
    <div class="section">
      <div class="section-header">
        <h2>Backend</h2>
        <button id="btn-backend-chooser" class="button-secondary">Backend</button>
      </div>
      <div class="card">
        <div class="backend-target">
          <div class="backend-target-main">
            <div class="backend-badge">AI</div>
            <div>
              <h3 id="backend-target-name">OpenCode</h3>
              <div class="backend-meta">Current backend target</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-header"><h2>Current Session</h2></div>
      <div class="session-grid">
        <div class="card">
          <h3>Agent</h3>
          <div class="desc">Agent for the next request</div>
          <div class="dropdown-container">
            <button id="agent-dropdown-trigger" class="dropdown-trigger">
              <div id="agent-dropdown-selected">
                <div class="item-title">Select Agent</div>
                <div class="item-meta">...</div>
              </div>
              <div class="dropdown-trigger-icon">▼</div>
            </button>
            <div id="agent-dropdown-panel" class="dropdown-panel"></div>
          </div>
        </div>
        <div class="card">
          <h3>Models</h3>
          <div class="desc">Model for the next request</div>
          <div class="dropdown-container">
            <button id="model-dropdown-trigger" class="dropdown-trigger">
              <div id="model-dropdown-selected">
                <div class="item-title">Select Model</div>
                <div class="item-meta">...</div>
              </div>
              <div class="dropdown-trigger-icon">▼</div>
            </button>
            <div id="model-dropdown-panel" class="dropdown-panel"></div>
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-header"><h2>Backend Setting</h2></div>
      <div id="backend-settings-container">
        <div class="empty-state">Loading backend settings...</div>
      </div>
    </div>

    <div class="section">
      <div class="section-header"><h2>Default</h2></div>
      <div class="card">
        <div class="field">
          <label>Default Agent</label>
          <div class="desc">Agent used when starting new sessions</div>
          <select id="sel-default-agent"></select>
        </div>
        <div class="field">
          <label>Default Model</label>
          <div class="desc">Model used when no model is specified per-agent</div>
          <select id="sel-default-model"></select>
        </div>
      </div>
    </div>
  </section>

  <section id="tab-global" class="tab-content hidden">
    <div class="section">
      <div class="section-header"><h2>Global Setting</h2></div>
      <div class="empty-state">Global ACP extension settings will be added here later.</div>
    </div>
  </section>

  <div id="add-provider-modal" class="modal-backdrop hidden">
    <div class="modal">
      <h3>Connect Provider</h3>
      <div id="add-provider-grid" class="provider-grid-add"></div>
      <div id="add-provider-form-section" class="provider-form hidden">
        <div class="field">
          <label>API Key</label>
          <div class="desc">Enter your API key for this provider</div>
          <input type="password" id="add-provider-apikey" placeholder="Enter API key">
        </div>
        <div class="field hidden" id="add-provider-baseurl-field">
          <label>Base URL</label>
          <div class="desc">Custom API endpoint (optional)</div>
          <input type="text" id="add-provider-baseurl" placeholder="https://api.example.com/v1">
        </div>
        <div class="provider-form-actions">
          <button id="btn-add-provider-cancel" class="button-secondary">Cancel</button>
          <button id="btn-add-provider-connect">Connect</button>
        </div>
      </div>
    </div>
  </div>

  <div id="edit-provider-modal" class="modal-backdrop hidden">
    <div class="modal">
      <h3>Edit Provider</h3>
      <div class="provider-form">
        <div class="field">
          <label>API Key</label>
          <div class="desc">Update your API key for this provider</div>
          <input type="password" id="edit-provider-apikey" placeholder="Enter new API key">
        </div>
        <div class="field hidden" id="edit-provider-baseurl-field">
          <label>Base URL</label>
          <div class="desc">Custom API endpoint (optional)</div>
          <input type="text" id="edit-provider-baseurl" placeholder="https://api.example.com/v1">
        </div>
        <div class="provider-form-actions">
          <button id="btn-edit-provider-disconnect" class="button-secondary" style="color: #f44; border-color: #f44;">Disconnect</button>
          <button id="btn-edit-provider-cancel" class="button-secondary">Cancel</button>
          <button id="btn-edit-provider-save">Save</button>
        </div>
      </div>
    </div>
  </div>

  <div id="backend-chooser-modal" class="modal-backdrop hidden">
    <div class="modal">
      <h3>Choose Backend</h3>
      <div class="desc">Backend switching UI placeholder. Current implementation only supports OpenCode. Custom backend entry is interface-only for now.</div>
      <div class="card">
        <div class="list-card-item selected">
          <div class="item-title">OpenCode</div>
          <div class="item-meta">Built-in backend</div>
        </div>
        <div class="list-card-item">
          <div class="item-title">Custom Backend</div>
          <div class="item-meta">Placeholder only — no runtime implementation yet</div>
        </div>
      </div>
      <div class="modal-actions">
        <button id="btn-close-backend-chooser" class="button-secondary">Close</button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let currentData = null;

    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.remove('hidden');
      });
    });

    // Subtab switching via event delegation (works for dynamic subtabs)
    document.getElementById('backend-settings-container').addEventListener('click', (event) => {
      const subtab = event.target.closest('.subtab');
      if (subtab && subtab.dataset.subtab) {
        const container = document.getElementById('backend-settings-container');
        container.querySelectorAll('.subtab').forEach(t => t.classList.remove('active'));
        container.querySelectorAll('.subtab-content').forEach(c => c.classList.add('hidden'));
        subtab.classList.add('active');
        const target = document.getElementById('bs-tab-' + subtab.dataset.subtab);
        if (target) { target.classList.remove('hidden'); }
      }
    });

    document.getElementById('btn-backend-chooser').addEventListener('click', () => {
      document.getElementById('backend-chooser-modal').classList.remove('hidden');
    });
    document.getElementById('btn-close-backend-chooser').addEventListener('click', () => {
      document.getElementById('backend-chooser-modal').classList.add('hidden');
    });
    document.getElementById('backend-chooser-modal').addEventListener('click', (event) => {
      if (event.target && event.target.id === 'backend-chooser-modal') {
        document.getElementById('backend-chooser-modal').classList.add('hidden');
      }
    });

    document.addEventListener('click', (event) => {
      const isAgentDropdown = event.target.closest('#agent-dropdown-trigger');
      const isModelDropdown = event.target.closest('#model-dropdown-trigger');
      
      if (isAgentDropdown) {
        document.getElementById('agent-dropdown-panel').classList.toggle('open');
        document.getElementById('model-dropdown-panel').classList.remove('open');
      } else if (isModelDropdown) {
        document.getElementById('model-dropdown-panel').classList.toggle('open');
        document.getElementById('agent-dropdown-panel').classList.remove('open');
      } else if (!event.target.closest('.dropdown-panel')) {
        document.getElementById('agent-dropdown-panel').classList.remove('open');
        document.getElementById('model-dropdown-panel').classList.remove('open');
      }
    });

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'updateData') {
        currentData = msg.data;
        renderData(msg.data);
        renderProviders();
      }
    });

    function renderData(data) {
      document.getElementById('backend-target-name').textContent = data.backendName || 'Backend';

      const agentSelected = document.getElementById('agent-dropdown-selected');
      const agentPanel = document.getElementById('agent-dropdown-panel');
      agentPanel.innerHTML = '';
      
      let currentAgentName = 'Select Agent';
      let currentAgentMeta = '...';
      
      (data.agents || []).filter(a => !a.hidden && a.mode !== 'subagent').forEach(a => {
        const isSelected = a.id === data.currentAgent;
        if (isSelected) {
          currentAgentName = a.name || a.id;
          currentAgentMeta = a.description || a.mode || '';
        }
        const item = document.createElement('div');
        item.className = 'list-card-item' + (isSelected ? ' selected' : '');
        item.innerHTML = '<div class="item-title">' + escapeHtml(a.name || a.id) + '</div>' +
          '<div class="item-meta">' + escapeHtml(a.description || a.mode || '') + '</div>';
        item.onclick = (e) => {
          e.stopPropagation();
          document.getElementById('agent-dropdown-panel').classList.remove('open');
          vscode.postMessage({ type: 'setAgent', agentId: a.id });
        };
        agentPanel.appendChild(item);
      });
      
      agentSelected.innerHTML = '<div class="item-title">' + escapeHtml(currentAgentName) + '</div>' +
        '<div class="item-meta">' + escapeHtml(currentAgentMeta) + '</div>';

      const modelSelected = document.getElementById('model-dropdown-selected');
      const modelPanel = document.getElementById('model-dropdown-panel');
      modelPanel.innerHTML = '';
      
      let currentModelName = data.currentModelDisplayName || data.defaultModel || 'Select Model';
      let currentModelMeta = '...';
      const currentModelId = (data.currentModel && data.currentModel.modelID) || data.defaultModel;

      if (!data.models || data.models.length === 0) {
        modelPanel.innerHTML = '<div class="empty-state">No models available from the current backend configuration.</div>';
      } else {
        let matched = false;
        data.models.forEach(m => {
          let isSelected = false;
          if (currentModelId) {
            isSelected = m.id === currentModelId;
            if (!isSelected && currentModelId.includes('/')) {
              isSelected = m.id === currentModelId.split('/').pop();
            }
            if (!isSelected && m.id.includes('/')) {
              isSelected = m.id.split('/').pop() === currentModelId;
            }
            if (!isSelected) {
              isSelected = m.id.includes(currentModelId) || currentModelId.includes(m.id);
            }
          }
          if (isSelected) {
            matched = true;
            currentModelName = m.name || m.id;
            currentModelMeta = m.provider || 'Unknown provider';
          }
          const item = document.createElement('div');
          item.className = 'list-card-item' + (isSelected ? ' selected' : '');
          item.innerHTML = '<div class="item-title">' + escapeHtml(m.name || m.id) + '</div>' +
            '<div class="item-meta">' + escapeHtml(m.provider || 'Unknown provider') + '</div>';
          item.onclick = (e) => {
            e.stopPropagation();
            document.getElementById('model-dropdown-panel').classList.remove('open');
            vscode.postMessage({ type: 'setModel', providerID: m.providerId || '', modelID: m.id });
          };
          modelPanel.appendChild(item);
        });
      }
      
      modelSelected.innerHTML = '<div class="item-title">' + escapeHtml(currentModelName) + '</div>' +
        '<div class="item-meta">' + escapeHtml(currentModelMeta) + '</div>';

      const selDefaultAgent = document.getElementById('sel-default-agent');
      selDefaultAgent.innerHTML = '<option value="">(none)</option>';
      (data.agents || []).filter(a => !a.hidden).forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = a.name || a.id;
        if (a.id === data.defaultAgent) opt.selected = true;
        selDefaultAgent.appendChild(opt);
      });
      selDefaultAgent.onchange = () => vscode.postMessage({ type: 'setDefaultAgent', agent: selDefaultAgent.value });

      const selDefaultModel = document.getElementById('sel-default-model');
      selDefaultModel.innerHTML = '<option value="">(none)</option>';
      (data.models || []).forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = (m.name || m.id) + (m.provider ? ' (' + m.provider + ')' : '');
        if (m.id === data.defaultModel) opt.selected = true;
        selDefaultModel.appendChild(opt);
      });
      selDefaultModel.onchange = () => vscode.postMessage({ type: 'setDefaultModel', model: selDefaultModel.value });

      // Render backend-specific settings from descriptor
      renderBackendSettings(data.backendSettings);
    }

    // =========================================================================
    // Dynamic backend settings rendering
    // =========================================================================

    function renderBackendSettings(descriptor) {
      const container = document.getElementById('backend-settings-container');
      container.innerHTML = '';

      if (!descriptor || !descriptor.tabs || descriptor.tabs.length === 0) {
        container.innerHTML = '<div class="empty-state">No backend-specific settings available for the current backend.</div>';
        return;
      }

      // Create subtabs if multiple tabs
      if (descriptor.tabs.length > 1) {
        const subtabs = document.createElement('div');
        subtabs.className = 'subtabs';
        descriptor.tabs.forEach((tab, i) => {
          const subtab = document.createElement('div');
          subtab.className = 'subtab' + (i === 0 ? ' active' : '');
          subtab.dataset.subtab = tab.id;
          subtab.textContent = tab.title;
          subtabs.appendChild(subtab);
        });
        container.appendChild(subtabs);
      }

      // Create tab content sections
      descriptor.tabs.forEach((tab, tabIndex) => {
        const section = document.createElement('section');
        section.id = 'bs-tab-' + tab.id;
        section.className = 'subtab-content' + (tabIndex > 0 ? ' hidden' : '');

        // Special rendering for Provider tab
        if (tab.id === 'provider') {
          renderProviderContent(section);
        } else {
          tab.groups.forEach(group => {
            const groupEl = renderGroup(group, descriptor.values);
            section.appendChild(groupEl);
          });

          // Save button per tab
          const saveRow = document.createElement('div');
          saveRow.style.marginTop = '12px';
          const saveBtn = document.createElement('button');
          saveBtn.textContent = 'Save Configuration';
          saveBtn.addEventListener('click', () => {
            const values = collectBackendSettings();
            vscode.postMessage({ type: 'saveBackendSettings', values });
          });
          saveRow.appendChild(saveBtn);
          section.appendChild(saveRow);
        }

        container.appendChild(section);
      });
    }

    function renderProviderContent(section) {
      // Section header with title and + button
      const header = document.createElement('div');
      header.className = 'section-header';
      const title = document.createElement('h2');
      title.textContent = 'Provider';
      header.appendChild(title);

      const addBtn = document.createElement('button');
      addBtn.className = 'provider-add-btn';
      addBtn.textContent = '+';
      addBtn.title = 'Add provider';
      addBtn.addEventListener('click', openAddProviderModal);
      header.appendChild(addBtn);

      section.appendChild(header);

      // Provider list container
      const list = document.createElement('div');
      list.className = 'provider-list';
      list.id = 'provider-list';
      section.appendChild(list);

      renderProviders();
    }

    function renderProviders() {
      const list = document.getElementById('provider-list');
      if (!list) return;
      list.innerHTML = '';

      const connected = currentData?.connectedProviders || [];

      if (connected.length === 0) {
        list.innerHTML = '<div class="empty-state">No providers connected yet. Click + to add one.</div>';
        return;
      }

      connected.forEach(p => {
        const card = document.createElement('div');
        card.className = 'provider-item';
        card.innerHTML =
          '<div class="provider-item-header">' +
            '<span class="provider-item-name">' + escapeHtml(p.name) + '</span>' +
            '<span class="provider-item-status">Connected</span>' +
          '</div>' +
          '<div class="provider-item-actions">' +
            '<button class="button-secondary provider-edit-btn" data-configkey="' + escapeHtml(p.configKey) + '" data-id="' + escapeHtml(p.id) + '">Edit</button>' +
            '<button class="button-secondary provider-disconnect-btn" data-configkey="' + escapeHtml(p.configKey) + '" data-id="' + escapeHtml(p.id) + '" style="color: #f44; border-color: #f44;">Disconnect</button>' +
          '</div>';
        list.appendChild(card);
      });

      // Attach event handlers
      list.querySelectorAll('.provider-edit-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          openEditProviderModal(btn.dataset.configkey, btn.dataset.id);
        });
      });

      list.querySelectorAll('.provider-disconnect-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          disconnectProvider(btn.dataset.configkey);
        });
      });
    }

    // =========================================================================
    // Provider modals and interactions
    // =========================================================================

    let selectedAddProviderId = null;

    function openAddProviderModal() {
      if (!currentData?.availableProviders) return;

      const grid = document.getElementById('add-provider-grid');
      grid.innerHTML = '';

      // Filter out already-connected providers (by id)
      const connectedIds = new Set((currentData.connectedProviders || []).map(p => p.id));
      const available = currentData.availableProviders.filter(p => !connectedIds.has(p.id));
      if (available.length === 0) {
        grid.innerHTML = '<div class="empty-state">All supported providers are already connected.</div>';
      } else {
        available.forEach(p => {
          const item = document.createElement('div');
          item.className = 'provider-option';
          item.dataset.providerId = p.id;
          item.innerHTML =
            '<div class="provider-option-name">' + escapeHtml(p.name) + '</div>' +
            (p.description ? '<div class="provider-option-desc">' + escapeHtml(p.description) + '</div>' : '');
          item.addEventListener('click', () => selectProviderOption(p.id));
          grid.appendChild(item);
        });
      }

      // Reset form
      document.getElementById('add-provider-form-section').classList.add('hidden');
      selectedAddProviderId = null;
      document.getElementById('add-provider-apikey').value = '';
      document.getElementById('add-provider-baseurl').value = '';
      document.getElementById('add-provider-baseurl-field').classList.add('hidden');

      // Remove any previous selection
      grid.querySelectorAll('.provider-option.selected').forEach(el => el.classList.remove('selected'));

      document.getElementById('add-provider-modal').classList.remove('hidden');
    }

    function selectProviderOption(providerId) {
      const grid = document.getElementById('add-provider-grid');
      grid.querySelectorAll('.provider-option').forEach(el => {
        el.classList.toggle('selected', el.dataset.providerId === providerId);
      });

      selectedAddProviderId = providerId;

      // Show form
      const form = document.getElementById('add-provider-form-section');
      form.classList.remove('hidden');

      // Show/hide base URL field based on provider type
      const available = (currentData?.availableProviders || []);
      const provider = available.find(p => p.id === providerId);
      const baseURLField = document.getElementById('add-provider-baseurl-field');
      if (provider?.requiresBaseURL) {
        baseURLField.classList.remove('hidden');
      } else {
        baseURLField.classList.add('hidden');
      }
    }

    function submitConnectProvider() {
      if (!selectedAddProviderId) return;
      const apiKey = document.getElementById('add-provider-apikey').value.trim();
      if (!apiKey) { alert('API Key is required'); return; }
      const baseURL = document.getElementById('add-provider-baseurl').value.trim();
      vscode.postMessage({
        type: 'connectProvider',
        providerId: selectedAddProviderId,
        apiKey,
        baseURL: baseURL || undefined,
      });
      document.getElementById('add-provider-modal').classList.add('hidden');
    }

    let editingProviderConfigKey = null;

    function openEditProviderModal(configKey, providerId) {
      if (!currentData?.connectedProviders) return;
      const provider = currentData.connectedProviders.find(p => p.configKey === configKey);
      if (!provider) return;

      editingProviderConfigKey = configKey;
      document.getElementById('edit-provider-apikey').value = '';
      document.getElementById('edit-provider-baseurl').value = '';

      // Show/hide base URL field
      const baseURLField = document.getElementById('edit-provider-baseurl-field');
      if (provider.hasBaseURL || provider.baseURL) {
        baseURLField.classList.remove('hidden');
        document.getElementById('edit-provider-baseurl').value = provider.baseURL || '';
      } else {
        baseURLField.classList.add('hidden');
      }

      document.getElementById('edit-provider-modal').classList.remove('hidden');
    }

    function submitEditProvider() {
      if (!editingProviderConfigKey) return;
      const apiKey = document.getElementById('edit-provider-apikey').value.trim();
      if (!apiKey) { alert('API Key is required'); return; }
      const baseURL = document.getElementById('edit-provider-baseurl').value.trim();
      vscode.postMessage({
        type: 'updateProvider',
        configKey: editingProviderConfigKey,
        apiKey,
        baseURL: baseURL || undefined,
      });
      document.getElementById('edit-provider-modal').classList.add('hidden');
      editingProviderConfigKey = null;
    }

    function disconnectProvider(providerId) {
      if (!confirm('Disconnect this provider? You will need to re-enter the API key to use it again.')) return;
      vscode.postMessage({
        type: 'disconnectProvider',
        configKey: providerId,
      });
    }

    // ── Modal event bindings ────────────────────────────────────────────

    // Close add-provider modal (click backdrop)
    document.getElementById('add-provider-modal').addEventListener('click', (event) => {
      if (event.target.id === 'add-provider-modal') {
        document.getElementById('add-provider-modal').classList.add('hidden');
      }
    });

    // Add: connect button
    document.getElementById('btn-add-provider-connect').addEventListener('click', submitConnectProvider);

    // Add: cancel button
    document.getElementById('btn-add-provider-cancel').addEventListener('click', () => {
      document.getElementById('add-provider-modal').classList.add('hidden');
    });

    // Edit: save button
    document.getElementById('btn-edit-provider-save').addEventListener('click', submitEditProvider);

    // Edit: cancel button
    document.getElementById('btn-edit-provider-cancel').addEventListener('click', () => {
      document.getElementById('edit-provider-modal').classList.add('hidden');
      editingProviderConfigKey = null;
    });

    // Edit: disconnect button
    document.getElementById('btn-edit-provider-disconnect').addEventListener('click', () => {
      if (!editingProviderConfigKey) return;
      disconnectProvider(editingProviderConfigKey);
      document.getElementById('edit-provider-modal').classList.add('hidden');
      editingProviderConfigKey = null;
    });

    // Close edit-provider modal (click backdrop)
    document.getElementById('edit-provider-modal').addEventListener('click', (event) => {
      if (event.target.id === 'edit-provider-modal') {
        document.getElementById('edit-provider-modal').classList.add('hidden');
        editingProviderConfigKey = null;
      }
    });

    // =========================================================================

    function renderGroup(group, values) {
      const wrapper = document.createElement('div');

      if (group.collapsible && group.title) {
        const details = document.createElement('details');
        details.className = 'card';
        details.open = true;
        const summary = document.createElement('summary');
        summary.style.cssText = 'cursor:pointer; font-weight:600;';
        summary.textContent = group.title;
        details.appendChild(summary);

        const inner = document.createElement('div');
        inner.style.marginTop = '12px';
        group.fields.forEach(field => inner.appendChild(renderField(field, values)));
        details.appendChild(inner);

        wrapper.appendChild(details);
      } else if (group.title) {
        const card = document.createElement('div');
        card.className = 'card';
        const title = document.createElement('h3');
        title.textContent = group.title;
        card.appendChild(title);
        group.fields.forEach(field => card.appendChild(renderField(field, values)));
        wrapper.appendChild(card);
      } else {
        const card = document.createElement('div');
        card.className = 'card';
        group.fields.forEach(field => card.appendChild(renderField(field, values)));
        wrapper.appendChild(card);
      }

      return wrapper;
    }

    function renderField(field, values) {
      switch (field.type) {
        case 'text': return renderTextField(field, values);
        case 'select': return renderSelectField(field, values);
        case 'toggle': return renderToggleField(field, values);
        case 'info-cards': return renderInfoCards(field);
        case 'map': return renderMapField(field, values);
        default: return document.createElement('div');
      }
    }

    function renderTextField(field, values) {
      const currentValue = getNestedValue(values, field.key) || '';
      const el = document.createElement('div');
      el.className = 'field';
      el.innerHTML =
        '<label>' + escapeHtml(field.label) + '</label>' +
        (field.description ? '<div class="desc">' + escapeHtml(field.description) + '</div>' : '') +
        '<input type="text" data-bs-path="' + escapeHtml(field.key) + '" value="' + escapeHtml(String(currentValue)) + '"' +
        (field.placeholder ? ' placeholder="' + escapeHtml(field.placeholder) + '"' : '') + '>';
      return el;
    }

    function renderSelectField(field, values) {
      const currentValue = getNestedValue(values, field.key) || '';
      const el = document.createElement('div');
      el.className = 'field';
      const optionsHtml = (field.options || []).map(opt => {
        const selected = opt.value === currentValue ? ' selected' : '';
        return '<option value="' + escapeHtml(opt.value) + '"' + selected + '>' + escapeHtml(opt.label) + '</option>';
      }).join('');
      el.innerHTML =
        '<label>' + escapeHtml(field.label) + '</label>' +
        (field.description ? '<div class="desc">' + escapeHtml(field.description) + '</div>' : '') +
        '<select data-bs-path="' + escapeHtml(field.key) + '">' + optionsHtml + '</select>';
      return el;
    }

    function renderToggleField(field, values) {
      const currentValue = getNestedValue(values, field.key) || false;
      const el = document.createElement('div');
      el.className = 'field';
      el.innerHTML =
        '<label>' + escapeHtml(field.label) + '</label>' +
        (field.description ? '<div class="desc">' + escapeHtml(field.description) + '</div>' : '') +
        '<input type="checkbox" data-bs-path="' + escapeHtml(field.key) + '"' + (currentValue ? ' checked' : '') + '>';
      return el;
    }

    function renderInfoCards(field) {
      const grid = document.createElement('div');
      grid.className = 'provider-grid';
      (field.items || []).forEach(item => {
        const card = document.createElement('div');
        card.className = 'provider-card';
        card.innerHTML = '<h3>' + escapeHtml(item.title) + '</h3>' +
          (item.details || []).map(d =>
            '<div class="field"><label>' + escapeHtml(d.label) + '</label><div class="desc">' + escapeHtml(d.value) + '</div></div>'
          ).join('');
        grid.appendChild(card);
      });
      if ((field.items || []).length === 0) {
        grid.innerHTML = '<div class="empty-state">No provider-specific configuration is defined for the current backend.</div>';
      }
      return grid;
    }

    function renderMapField(field, values) {
      const container = document.createElement('div');
      if (field.label) {
        const title = document.createElement('h3');
        title.textContent = field.label;
        container.appendChild(title);
      }
      if (field.description) {
        const desc = document.createElement('div');
        desc.className = 'desc';
        desc.textContent = field.description;
        desc.style.marginBottom = '10px';
        container.appendChild(desc);
      }
      (field.items || []).forEach(item => {
        const card = document.createElement('div');
        card.className = 'card';
        const itemTitle = document.createElement('h3');
        itemTitle.textContent = item.label;
        card.appendChild(itemTitle);

        field.fields.forEach(subField => {
          const path = field.key + '.' + item.id + '.' + subField.key;
          const subValues = getNestedValue(values, field.key + '.' + item.id) || {};
          const el = createSubFieldElement(subField, path, subValues);
          card.appendChild(el);
        });

        container.appendChild(card);
      });
      return container;
    }

    function createSubFieldElement(field, path, values) {
      const wrapper = document.createElement('div');
      wrapper.className = 'field';

      const label = document.createElement('label');
      label.textContent = field.label;
      wrapper.appendChild(label);

      if (field.description) {
        const desc = document.createElement('div');
        desc.className = 'desc';
        desc.textContent = field.description;
        wrapper.appendChild(desc);
      }

      const currentValue = values[field.key] || '';

      if (field.type === 'select') {
        const select = document.createElement('select');
        select.dataset.bsPath = path;
        (field.options || []).forEach(opt => {
          const option = document.createElement('option');
          option.value = opt.value;
          option.textContent = opt.label;
          if (opt.value === currentValue) option.selected = true;
          select.appendChild(option);
        });
        wrapper.appendChild(select);
      } else if (field.type === 'text') {
        const input = document.createElement('input');
        input.type = 'text';
        input.dataset.bsPath = path;
        input.value = currentValue;
        if (field.placeholder) input.placeholder = field.placeholder;
        wrapper.appendChild(input);
      } else if (field.type === 'toggle') {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.bsPath = path;
        if (currentValue) input.checked = true;
        wrapper.appendChild(input);
      }

      return wrapper;
    }

    // -- Value collection -----------------------------------------------

    function collectBackendSettings() {
      const values = {};
      document.querySelectorAll('[data-bs-path]').forEach(el => {
        const path = el.dataset.bsPath;
        if (!path) return;
        const parts = path.split('.');
        let obj = values;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!obj[parts[i]]) obj[parts[i]] = {};
          obj = obj[parts[i]];
        }
        const key = parts[parts.length - 1];
        if (el.type === 'checkbox') {
          if (el.checked) obj[key] = el.checked;
        } else {
          if (el.value) obj[key] = el.value;
        }
      });
      return values;
    }

    // -- Helpers --------------------------------------------------------

    function getNestedValue(obj, path) {
      if (!obj || !path) return undefined;
      return path.split('.').reduce((o, k) => o?.[k], obj);
    }

    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
