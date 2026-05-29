/**
 * Settings state persistence — stores current agent/model selection in
 * VS Code globalState so that preferences survive extension reloads.
 *
 * == Usage ==
 * ```
 * // On activation — hydrate state from persisted values
 * hydrateStateFromPersisted(context, extensionState);
 *
 * // After every user-initiated agent/model change — persist
 * savePersistedSettingsState(context, {
 *   currentAgent: newAgent,
 *   currentModel: newModel,
 *   currentModelDisplayName: newDisplayName,
 * });
 * ```
 *
 * == Fallback order ==
 * 1. Persisted override (globalState) — survives reload
 * 2. Backend config default (config.default_agent / config.model) — no override
 * 3. First primary agent / agent's baked-in model — no override
 *
 * @module
 */

import * as vscode from 'vscode';
import type { ExtensionState, PersistedSettingsState } from '../types';

const SETTINGS_STATE_KEY = 'opencode.settingsState';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read persisted settings state from VS Code globalState (returns {} if none) */
export function loadPersistedSettingsState(context: vscode.ExtensionContext): PersistedSettingsState {
  return context.globalState.get<PersistedSettingsState>(SETTINGS_STATE_KEY) ?? {};
}

/** Persist settings state to VS Code globalState (only defined fields are stored) */
export function savePersistedSettingsState(
  context: vscode.ExtensionContext,
  state: PersistedSettingsState,
): void {
  context.globalState.update(SETTINGS_STATE_KEY, state);
}

/** Hydrate extension state fields from persisted settings (only sets undefined fields) */
export function hydrateStateFromPersisted(
  context: vscode.ExtensionContext,
  state: ExtensionState,
): void {
  const persisted = loadPersistedSettingsState(context);

  // Only set fields that are NOT already defined — this ensures that
  // loadDefaultsFromConfig (which runs after hydration) respects the
  // persisted values and won't overwrite them with backend defaults.
  if (state.currentAgent === undefined && persisted.currentAgent !== undefined) {
    state.currentAgent = persisted.currentAgent;
  }
  if (state.currentModel === undefined && persisted.currentModel !== undefined) {
    state.currentModel = persisted.currentModel;
  }
  if (state.currentModelDisplayName === undefined && persisted.currentModelDisplayName !== undefined) {
    state.currentModelDisplayName = persisted.currentModelDisplayName;
  }

  state.outputChannel.appendLine(
    `[state-persistence] Hydrated from globalState: agent=${state.currentAgent ?? 'none'}, model=${JSON.stringify(state.currentModel)}, displayName=${state.currentModelDisplayName ?? 'none'}`,
  );
}

/** Extract PersistedSettingsState fields from an ExtensionState */
export function extractPersistedState(s: ExtensionState): PersistedSettingsState {
  return {
    currentAgent: s.currentAgent,
    currentModel: s.currentModel,
    currentModelDisplayName: s.currentModelDisplayName,
  };
}
