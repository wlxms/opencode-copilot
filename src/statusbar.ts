/**
 * Status bar controller — shows backend, agent, and model in the VS Code status bar.
 *
 * Three items aligned right:
 *   $(server) OpenCode   — current backend name
 *   $(robot) Build       — current agent name
 *   $(sparkle) gpt-4o    — current model name
 *
 * Clicking any item opens the settings webview panel.
 */
import * as vscode from 'vscode';

export interface StatusBarState {
  backendName: string;
  agentName: string;
  modelName: string;
}

export class StatusBarManager implements vscode.Disposable {
  private readonly backendItem: vscode.StatusBarItem;
  private readonly agentItem: vscode.StatusBarItem;
  private readonly modelItem: vscode.StatusBarItem;
  private readonly _onDidClick = new vscode.EventEmitter<void>();
  readonly onDidClick = this._onDidClick.event;

  constructor() {
    // Create 3 status bar items, aligned right, with descending priority
    this.backendItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.agentItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      99,
    );
    this.modelItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      98,
    );

    // Set icons and tooltips
    this.backendItem.text = '$(server) OpenCode';
    this.backendItem.tooltip = 'OpenCode Backend';
    this.backendItem.command = 'opencode.openSettings';

    this.agentItem.text = '$(robot) --';
    this.agentItem.tooltip = 'Current Agent (click to change)';
    this.agentItem.command = 'opencode.openSettings';

    this.modelItem.text = '$(sparkle) --';
    this.modelItem.tooltip = 'Current Model (click to change)';
    this.modelItem.command = 'opencode.openSettings';

    // Show all items
    this.backendItem.show();
    this.agentItem.show();
    this.modelItem.show();
  }

  /** Update all status bar items from the given state */
  update(state: StatusBarState): void {
    this.backendItem.text = `$(server) ${state.backendName}`;
    this.agentItem.text = `$(robot) ${state.agentName}`;
    this.modelItem.text = `$(sparkle) ${state.modelName}`;
  }

  /** Update just the backend display */
  updateBackend(name: string): void {
    this.backendItem.text = `$(server) ${name}`;
  }

  /** Update just the agent display */
  updateAgent(name: string): void {
    this.agentItem.text = `$(robot) ${name}`;
  }

  /** Update just the model display */
  updateModel(name: string): void {
    this.modelItem.text = `$(sparkle) ${name}`;
  }

  dispose(): void {
    this.backendItem.dispose();
    this.agentItem.dispose();
    this.modelItem.dispose();
    this._onDidClick.dispose();
  }
}
