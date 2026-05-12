import * as vscode from 'vscode';
import type { Model, Provider } from '@opencode-ai/sdk';
import type { ExtensionState } from '../types';
import { ErrorMessages } from './errors';
import { ensureServer } from './handler';

export async function routeCommand(
  command: string,
  state: ExtensionState,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  switch (command.toLowerCase()) {
    case 'new':
      await handleNewCommand(state, stream);
      break;
    case 'help':
      handleHelpCommand(stream);
      break;
    case 'model':
      await handleModelCommand(state, stream);
      break;
    default:
      stream.markdown(
        `⚠️ Unknown command '/${command}'. Use **/help** to see available commands.`,
      );
  }
  return { metadata: {} };
}

async function handleNewCommand(
  state: ExtensionState,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const client = await ensureServer(state, stream);
  if (!client) return;
  try {
    const result = await client.session.create({ body: {} });
    const sessionId = result.data?.id;
    if (!sessionId) {
      throw new Error('Session not created');
    }
    state.activeSessionId = sessionId;
    stream.markdown('🆕 Started a new conversation session.');
    state.outputChannel.appendLine(`[commands] New session: ${sessionId}`);
  } catch {
    stream.markdown(ErrorMessages.SESSION_ERROR);
  }
}

function handleHelpCommand(stream: vscode.ChatResponseStream): void {
  stream.markdown(
    [
      '## Available Commands',
      '',
      '- **/new** — Start a new conversation session',
      '- **/help** — Show this help message',
      '- **/model** — Show the current active model',
      '',
      'Just type your message to chat with OpenCode!',
    ].join('\n'),
  );
}

async function handleModelCommand(
  state: ExtensionState,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const client = await ensureServer(state, stream);
  if (!client) return;
  try {
    const providersResp = await client.config.providers();
    const providerList: Provider[] = providersResp.data?.providers ?? [];
    if (providerList.length > 0) {
      const lines: string[] = ['## Available Models', ''];
      for (const p of providerList) {
        const models: Model[] = Object.values(p.models ?? {});
        const active = models.filter((model) => model.status === 'active');
        if (active.length > 0) {
          lines.push(`**${p.name}** (${p.id}):`);
          for (const m of active) {
            lines.push(`  - \`${m.id}\` — ${m.name}`);
          }
        }
      }
      stream.markdown(lines.join('\n'));
    } else {
      stream.markdown('No providers configured.');
    }
  } catch {
    stream.markdown('Unable to retrieve model information.');
  }
}
