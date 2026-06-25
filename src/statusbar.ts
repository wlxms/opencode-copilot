/**
 * Status bar controller — single item, markdown table tooltip.
 *
 * Status bar: $(acpilot-a) (icon only)
 * Hover: markdown table | Backend | Agent | Model |
 * Click: acpilot.openSettings
 */
import * as vscode from 'vscode';

export interface StatusBarState {
  backendName: string;
  agentName: string;
  modelName: string;
  isBackendActive: boolean;
}

export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.text = '$(acpilot-a)';
    this.item.command = 'acpilot.openSettings';
    this.item.name = 'ACP';
    this.item.show();
  }

  update(state: StatusBarState): void {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    const name = state.isBackendActive
      ? state.backendName
      : `${state.backendName} \\u26A0`;

    md.appendMarkdown(`**ACP Copilot**\n\n`);
    md.appendMarkdown(`| Backend | Agent | Model |\n`);
    md.appendMarkdown(`|---------|-------|-------|\n`);
    md.appendMarkdown(`| ${name} | ${state.agentName} | ${state.modelName} |`);

    this.item.tooltip = md;
  }

  updateError(backendName: string): void {
    this.update({
      backendName,
      agentName: '--',
      modelName: '--',
      isBackendActive: false,
    });
  }

  dispose(): void {
    this.item.dispose();
  }
}
