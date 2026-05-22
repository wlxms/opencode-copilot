import * as vscode from 'vscode';
import type { AcpBackend } from './acp/backend';
import { OpenCodeBackend } from './backends/opencode/adapter';
import { createParticipantHandler } from './participant/handler';
import { createSessionContentProvider } from './surfaces/vscode/experimental-session';
import { hasRegisterChatSessionContentProvider } from './surfaces/vscode/capabilities';
import type { ExtensionState } from './types';

let state: ExtensionState | undefined;

function isExperimentalSessionProviderEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('opencode')
    .get<boolean>('experimental.sessionProvider', false);
}

function createBackend(): AcpBackend {
  return new OpenCodeBackend();
}

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('OpenCode Copilot');
  outputChannel.appendLine('[extension] OpenCode Copilot activating...');

  const backend = createBackend();

  state = {
    backend,
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

  context.subscriptions.push(outputChannel, participant);
  outputChannel.appendLine('[extension] OpenCode Copilot activated');
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
