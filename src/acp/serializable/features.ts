import * as vscode from 'vscode';

export function useSerializableStreamParts(): boolean {
  return vscode.workspace
    .getConfiguration('opencode')
    .get('experimental.serializableStreamParts', true);
}
