import * as vscode from 'vscode';
import { OpenCodeServerManager } from './opencode/server';
import { createParticipantHandler } from './participant/handler';
import type { ExtensionState } from './types';

let state: ExtensionState | undefined;

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('OpenCode Copilot');
  outputChannel.appendLine('[extension] OpenCode Copilot activating...');

  const serverManager = new OpenCodeServerManager();

  state = {
    serverManager,
    client: null,
    activeSessionId: null,
    serverStatus: 'stopped',
    outputChannel,
    sessionMap: new Map(),
  };

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

  context.subscriptions.push(outputChannel, participant);
  outputChannel.appendLine('[extension] OpenCode Copilot activated');
}

export function deactivate() {
  if (state) {
    state.outputChannel.appendLine('[extension] Deactivating...');
    if (state.serverManager.isRunning()) {
      state.serverManager.stop().catch((err: unknown) => {
        state!.outputChannel.appendLine(
          `[extension] Stop error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }
}
