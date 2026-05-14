/**
 * Configuration utilities for the OpenCode Copilot extension.
 *
 * Reads VSCode settings via vscode.workspace.getConfiguration().
 * Currently only manages the checkpoint supervision mode.
 */

import * as vscode from 'vscode';

const SECTION = 'opencode-copilot';

/**
 * Checkpoint supervision mode determines how file-change checkpoints
 * are captured during an AI turn.
 *
 * - **permission**: Uses OpenCode's native permission protocol. The server
 *   pauses before each edit/write and emits `permission.asked`. The
 *   extension auto-approves and uses the pause as a precise checkpoint
 *   boundary. Zero race-condition risk. (default)
 *
 * - **turn**: Captures a single checkpoint for the entire turn (the
 *   original behaviour). The user can only undo after the turn completes.
 *
 * - **message**: Attempts per-tool-checkpoint by rapidly ending and
 *   restarting the checkpoint window when each tool completes. Fast but
 *   has a tiny race window because SSE is asynchronous.
 */
export type CheckpointMode = 'permission' | 'turn' | 'message';

export const CHECKPOINT_MODES: readonly { value: CheckpointMode; label: string; description: string }[] = [
  {
    value: 'permission',
    label: 'Permission (recommended)',
    description: 'Uses OpenCode permission protocol — zero race conditions, per-tool undo checkpoints.',
  },
  {
    value: 'turn',
    label: 'Turn',
    description: 'Single checkpoint per turn — classic behaviour, undo only available after turn ends.',
  },
  {
    value: 'message',
    label: 'Message (fast)',
    description: 'Per-tool checkpoint with rapid window switching — fast but has a small race window.',
  },
];

/**
 * Read the current checkpoint mode from VSCode settings.
 * Falls back to 'permission' if the value is unset or unrecognised.
 */
export function getCheckpointMode(): CheckpointMode {
  const raw = vscode.workspace.getConfiguration(SECTION).get<string>('checkpointMode', 'permission');
  if (raw === 'permission' || raw === 'turn' || raw === 'message') {
    return raw;
  }
  return 'permission';
}
