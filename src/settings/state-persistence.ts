/**
 * Settings state persistence — stores current agent/model selection in
 * VS Code globalState so that preferences survive extension reloads.
 *
 * == Usage ==
 * ```
 * // On activation — hydrate selection store from persisted values
 * const persisted = loadPersistedSettingsState(context);
 * selection.hydrate(persisted);
 *
 * // After every user-initiated agent/model change — persist
 * savePersistedSettingsState(context, selection.get());
 * ```
 *
 * @module
 */

import * as vscode from 'vscode';
import type { SelectionState } from '../acp/app-event-bus';
import type { PersistedSettingsState } from '../types';

const SETTINGS_STATE_KEY = 'acp.settingsState';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read persisted settings state from VS Code globalState (returns empty SelectionState if none) */
export function loadPersistedSettingsState(context: vscode.ExtensionContext): SelectionState {
  const persisted = context.globalState.get<PersistedSettingsState>(SETTINGS_STATE_KEY) ?? {};
  // Map from stored field names (currentAgent/currentModel/currentModelDisplayName)
  // to SelectionState field names (agent/model/modelDisplayName)
  return {
    agent: persisted.currentAgent,
    model: persisted.currentModel,
    modelDisplayName: persisted.currentModelDisplayName,
  };
}

/**
 * Persist settings state to VS Code globalState (only defined fields are stored).
 * Accepts SelectionState (from selection.get()) and maps to stored field names.
 */
export function savePersistedSettingsState(
  context: vscode.ExtensionContext,
  state: SelectionState,
): void {
  const persisted: PersistedSettingsState = {
    currentAgent: state.agent,
    currentModel: state.model,
    currentModelDisplayName: state.modelDisplayName,
  };
  context.globalState.update(SETTINGS_STATE_KEY, persisted);
}
