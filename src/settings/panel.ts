import * as vscode from 'vscode';

export type SettingsMessage =
  | { type: 'ready' }
  | { type: 'refreshData' }
  | { type: 'setAgent'; agentId: string }
  | { type: 'setModel'; providerID: string; modelID: string }
  | { type: 'setDefaultModel'; model: string }
  | { type: 'setDefaultAgent'; agent: string }
  | { type: 'updateConfig'; config: Record<string, unknown> };

export interface SettingsData {
  backendName: string;
  agents: Array<{ id: string; name?: string; description?: string; model?: string; mode?: string; hidden?: boolean }>;
  models: Array<{ id: string; name?: string; provider?: string; providerId?: string; capabilities?: string[] }>;
  currentAgent?: string;
  currentModel?: { providerID: string; modelID: string };
  currentModelDisplayName?: string;
  config: {
    model?: string;
    small_model?: string;
    default_agent?: string;
    disabled_providers?: string[];
    enabled_providers?: string[];
    agent?: Record<string, { model?: string; description?: string; disable?: boolean; mode?: string }>;
    provider?: Record<string, { name?: string; id?: string }>;
  };
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

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: SettingsMessage) => this.handleMessage(message),
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
      --selected: color-mix(in srgb, var(--accent) 14%, transparent);
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
    .list-card-item {
      padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 8px; cursor: pointer;
    }
    .list-card-item.selected { border-color: var(--accent); background: var(--selected); }
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
    .dropdown-trigger { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; background: var(--input-bg); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; color: var(--fg); text-align: left; }
    .dropdown-trigger:hover { border-color: var(--focus); }
    .dropdown-trigger .item-title { font-weight: 600; font-size: 13px; }
    .dropdown-trigger .item-meta { color: var(--muted); font-size: 11px; }
    .dropdown-trigger-icon { margin-left: 8px; color: var(--muted); font-size: 10px; }
    .dropdown-panel { position: absolute; top: 100%; left: 0; right: 0; margin-top: 4px; background: var(--card); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); max-height: 250px; overflow-y: auto; z-index: 100; padding: 8px; display: none; }
    .dropdown-panel.open { display: block; }
    .dropdown-panel .list-card-item { margin-bottom: 4px; }
    .dropdown-panel .list-card-item:last-child { margin-bottom: 0; }
    @media (max-width: 900px) { .session-grid { grid-template-columns: 1fr; } }
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
      <div class="subtabs">
        <div class="subtab active" data-subtab="override">Setting</div>
        <div class="subtab" data-subtab="provider">Provider</div>
      </div>

      <section id="subtab-override" class="subtab-content">
        <details class="card">
          <summary style="cursor:pointer; font-weight:600;">Override</summary>
          <div style="margin-top:12px;">
            <div class="field">
              <label>Global Default Model</label>
              <div class="desc">Fallback model for all agents</div>
              <input type="text" id="cfg-model" placeholder="e.g., gpt-4o">
            </div>
            <div class="field">
              <label>Small Model</label>
              <div class="desc">Lightweight model for quick tasks</div>
              <input type="text" id="cfg-small-model" placeholder="e.g., gpt-4o-mini">
            </div>
            <div id="agent-overrides"></div>
            <div style="margin-top:12px"><button id="btn-save-backend">Save Configuration</button></div>
          </div>
        </details>
      </section>

      <section id="subtab-provider" class="subtab-content hidden">
        <div id="provider-list" class="provider-grid"></div>
      </section>
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

    document.querySelectorAll('.subtab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.subtab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.subtab-content').forEach(c => c.classList.add('hidden'));
        tab.classList.add('active');
        document.getElementById('subtab-' + tab.dataset.subtab).classList.remove('hidden');
      });
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
      }
    });

    function renderData(data) {
      document.getElementById('backend-target-name').textContent = data.backendName || 'Backend';

      const agentSelected = document.getElementById('agent-dropdown-selected');
      const agentPanel = document.getElementById('agent-dropdown-panel');
      agentPanel.innerHTML = '';
      
      let currentAgentName = 'Select Agent';
      let currentAgentMeta = '...';
      
      (data.agents || []).filter(a => !a.hidden).forEach(a => {
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
      
      let currentModelName = data.currentModelDisplayName || data.config?.model || 'Select Model';
      let currentModelMeta = '...';
      const currentModelId = (data.currentModel && data.currentModel.modelID) || data.config?.model;

      if (!data.models || data.models.length === 0) {
        modelPanel.innerHTML = '<div class="empty-state">No models available from the current backend configuration.</div>';
      } else {
        data.models.forEach(m => {
          const isSelected = !!currentModelId && m.id === currentModelId;
          if (isSelected) {
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
        if (a.id === data.config?.default_agent) opt.selected = true;
        selDefaultAgent.appendChild(opt);
      });
      selDefaultAgent.onchange = () => vscode.postMessage({ type: 'setDefaultAgent', agent: selDefaultAgent.value });

      const selDefaultModel = document.getElementById('sel-default-model');
      selDefaultModel.innerHTML = '<option value="">(none)</option>';
      (data.models || []).forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = (m.name || m.id) + (m.provider ? ' (' + m.provider + ')' : '');
        if (m.id === data.config?.model) opt.selected = true;
        selDefaultModel.appendChild(opt);
      });
      selDefaultModel.onchange = () => vscode.postMessage({ type: 'setDefaultModel', model: selDefaultModel.value });

      document.getElementById('cfg-model').value = data.config?.model || '';
      document.getElementById('cfg-small-model').value = data.config?.small_model || '';

      renderAgentOverrides(data);
      renderProviders(data);
    }

    function renderAgentOverrides(data) {
      const container = document.getElementById('agent-overrides');
      container.innerHTML = '';
      const agentConfigs = data.config?.agent || {};
      (data.agents || []).filter(a => !a.hidden).forEach(a => {
        const cfg = agentConfigs[a.id] || {};
        const modelOptions = ['<option value="">(use global default)</option>']
          .concat((data.models || []).map(m => {
            const selected = cfg.model === m.id ? ' selected' : '';
            const label = escapeHtml((m.name || m.id) + (m.provider ? ' (' + m.provider + ')' : ''));
            return '<option value="' + escapeHtml(m.id) + '"' + selected + '>' + label + '</option>';
          })).join('');
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = '<h3>' + escapeHtml(a.name || a.id) + '</h3>' +
          '<div class="field"><label>Model Override</label><div class="desc">Per-agent model override</div>' +
          '<select data-agent="' + a.id + '" data-field="model">' + modelOptions + '</select></div>' +
          '<div class="field"><label>Description</label><div class="desc">Optional agent-specific description</div>' +
          '<input type="text" data-agent="' + a.id + '" data-field="description" value="' + escapeHtml(cfg.description || '') + '" placeholder="' + escapeHtml(a.description || '') + '"></div>';
        container.appendChild(card);
      });
    }

    function renderProviders(data) {
      const container = document.getElementById('provider-list');
      container.innerHTML = '';
      const providers = data.config?.provider || {};
      const entries = Object.entries(providers);
      if (entries.length === 0) {
        container.innerHTML = '<div class="empty-state">No provider-specific configuration is defined for the current backend.</div>';
        return;
      }
      entries.forEach(([key, value]) => {
        const card = document.createElement('div');
        card.className = 'provider-card';
        card.innerHTML = '<h3>' + escapeHtml(value.name || key) + '</h3>' +
          '<div class="field"><label>Provider ID</label><div class="desc">' + escapeHtml(value.id || key) + '</div></div>' +
          '<div class="field"><label>Config Key</label><div class="desc">' + escapeHtml(key) + '</div></div>';
        container.appendChild(card);
      });
    }

    document.getElementById('btn-save-backend').addEventListener('click', () => {
      if (!currentData) return;
      const config = {};
      config.model = document.getElementById('cfg-model').value || undefined;
      config.small_model = document.getElementById('cfg-small-model').value || undefined;

      const agentOverrides = {};
      document.querySelectorAll('#agent-overrides [data-agent]').forEach(input => {
        const agentId = input.dataset.agent;
        const field = input.dataset.field;
        if (!agentOverrides[agentId]) agentOverrides[agentId] = {};
        if (input.value) agentOverrides[agentId][field] = input.value;
      });
      if (Object.keys(agentOverrides).length > 0) config.agent = agentOverrides;

      vscode.postMessage({ type: 'updateConfig', config });
    });

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
