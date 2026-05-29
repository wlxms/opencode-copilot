import { describe, it, expect, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import {
  loadPersistedSettingsState,
  savePersistedSettingsState,
  hydrateStateFromPersisted,
  extractPersistedState,
} from '../settings/state-persistence';
import type { ExtensionState, PersistedSettingsState } from '../types';

// ---------------------------------------------------------------------------
// In-memory Memento for tests — mirrors VS Code's globalState contract
// ---------------------------------------------------------------------------
class TestMemento implements vscode.Memento {
  private store = new Map<string, unknown>();

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (this.store.has(key)) {
      return this.store.get(key) as T;
    }
    return defaultValue;
  }

  update(key: string, value: unknown): Thenable<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionPath: '/mock',
    extensionUri: vscode.Uri.parse('file:///mock'),
    globalState: new TestMemento(),
    workspaceState: new TestMemento(),
    storageUri: undefined,
    globalStorageUri: vscode.Uri.parse('file:///mock/globalStorage'),
    logUri: vscode.Uri.parse('file:///mock/logs'),
  };
}

function createMinimalState(overrides?: Partial<ExtensionState>): ExtensionState {
  return {
    backend: {
      name: 'opencode',
      start: async () => ({ data: { url: 'http://127.0.0.1:4096', status: 'running' as const } }),
      stop: async () => undefined,
      getStatus: () => 'running',
      isRunning: () => true,
      getUrl: () => 'http://127.0.0.1:4096',
      sessions: {} as ExtensionState['backend']['sessions'],
      config: {
        models: async () => ({ data: [{ id: 'gpt-4', name: 'GPT-4', provider: 'openai' }] }),
        agents: async () => ({ data: [] }),
        get: async () => ({ data: {} }),
        update: async () => ({ data: {} }),
      } as ExtensionState['backend']['config'],
      events: {} as ExtensionState['backend']['events'],
      permissions: {} as ExtensionState['backend']['permissions'],
      questions: {} as ExtensionState['backend']['questions'],
    },
    outputChannel: vscode.window.createOutputChannel('test'),
    sessionMap: new Map(),
    statusBar: { update: () => {} } as unknown as ExtensionState['statusBar'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('state-persistence', () => {
  let context: vscode.ExtensionContext;

  beforeEach(() => {
    context = createMockContext();
  });

  describe('loadPersistedSettingsState', () => {
    it('returns empty object when no persisted state exists', () => {
      const result = loadPersistedSettingsState(context);
      expect(result).toEqual({});
    });

    it('returns persisted state after save', () => {
      const saved: PersistedSettingsState = {
        currentAgent: 'primary-agent',
        currentModel: { providerID: 'openai', modelID: 'gpt-4' },
        currentModelDisplayName: 'GPT-4',
      };
      context.globalState.update('opencode.settingsState', saved);

      const result = loadPersistedSettingsState(context);
      expect(result).toEqual(saved);
    });
  });

  describe('savePersistedSettingsState', () => {
    it('persists and retrieves agent only', () => {
      savePersistedSettingsState(context, { currentAgent: 'coder' });

      const result = loadPersistedSettingsState(context);
      expect(result).toEqual({ currentAgent: 'coder' });
    });

    it('persists and retrieves model only', () => {
      savePersistedSettingsState(context, {
        currentModel: { providerID: 'anthropic', modelID: 'claude-3-opus' },
        currentModelDisplayName: 'Claude 3 Opus',
      });

      const result = loadPersistedSettingsState(context);
      expect(result).toEqual({
        currentModel: { providerID: 'anthropic', modelID: 'claude-3-opus' },
        currentModelDisplayName: 'Claude 3 Opus',
      });
    });

    it('persists full state and retrieves it', () => {
      const full: PersistedSettingsState = {
        currentAgent: 'planner',
        currentModel: { providerID: 'google', modelID: 'gemini-pro' },
        currentModelDisplayName: 'Gemini Pro',
      };
      savePersistedSettingsState(context, full);

      const result = loadPersistedSettingsState(context);
      expect(result).toEqual(full);
    });

    it('overwrites previous state on subsequent saves', () => {
      savePersistedSettingsState(context, { currentAgent: 'old' });
      savePersistedSettingsState(context, { currentAgent: 'new' });

      const result = loadPersistedSettingsState(context);
      expect(result).toEqual({ currentAgent: 'new' });
    });
  });

  describe('hydrateStateFromPersisted', () => {
    it('hydrates all fields from persisted state', () => {
      context.globalState.update('opencode.settingsState', {
        currentAgent: 'primary-agent',
        currentModel: { providerID: 'openai', modelID: 'gpt-4o' },
        currentModelDisplayName: 'GPT-4o',
      });

      const state = createMinimalState();
      expect(state.currentAgent).toBeUndefined();
      expect(state.currentModel).toBeUndefined();
      expect(state.currentModelDisplayName).toBeUndefined();

      hydrateStateFromPersisted(context, state);

      expect(state.currentAgent).toBe('primary-agent');
      expect(state.currentModel).toEqual({ providerID: 'openai', modelID: 'gpt-4o' });
      expect(state.currentModelDisplayName).toBe('GPT-4o');
    });

    it('does NOT overwrite already-set state values', () => {
      context.globalState.update('opencode.settingsState', {
        currentAgent: 'persisted-agent',
        currentModel: { providerID: 'openai', modelID: 'gpt-4o' },
        currentModelDisplayName: 'GPT-4o',
      });

      const state = createMinimalState({
        currentAgent: 'existing-agent',
        currentModel: { providerID: 'anthropic', modelID: 'claude-3' },
        currentModelDisplayName: 'Claude 3',
      });

      hydrateStateFromPersisted(context, state);

      // Existing values should remain unchanged
      expect(state.currentAgent).toBe('existing-agent');
      expect(state.currentModel).toEqual({ providerID: 'anthropic', modelID: 'claude-3' });
      expect(state.currentModelDisplayName).toBe('Claude 3');
    });

    it('handles empty persisted state gracefully', () => {
      const state = createMinimalState();
      hydrateStateFromPersisted(context, state);

      expect(state.currentAgent).toBeUndefined();
      expect(state.currentModel).toBeUndefined();
      expect(state.currentModelDisplayName).toBeUndefined();
    });

    it('hydrates partial state (agent only, no model)', () => {
      context.globalState.update('opencode.settingsState', {
        currentAgent: 'primary-agent',
      });

      const state = createMinimalState();
      hydrateStateFromPersisted(context, state);

      expect(state.currentAgent).toBe('primary-agent');
      expect(state.currentModel).toBeUndefined();
      expect(state.currentModelDisplayName).toBeUndefined();
    });

    it('hydrates partial state (model only, no agent)', () => {
      context.globalState.update('opencode.settingsState', {
        currentModel: { providerID: 'openai', modelID: 'gpt-4' },
        currentModelDisplayName: 'GPT-4',
      });

      const state = createMinimalState();
      hydrateStateFromPersisted(context, state);

      expect(state.currentAgent).toBeUndefined();
      expect(state.currentModel).toEqual({ providerID: 'openai', modelID: 'gpt-4' });
      expect(state.currentModelDisplayName).toBe('GPT-4');
    });
  });

  describe('extractPersistedState', () => {
    it('extracts currentAgent, currentModel, currentModelDisplayName', () => {
      const state = createMinimalState({
        currentAgent: 'extract-agent',
        currentModel: { providerID: 'openai', modelID: 'gpt-4' },
        currentModelDisplayName: 'GPT-4',
      });

      const result = extractPersistedState(state);
      expect(result).toEqual({
        currentAgent: 'extract-agent',
        currentModel: { providerID: 'openai', modelID: 'gpt-4' },
        currentModelDisplayName: 'GPT-4',
      });
    });

    it('handles undefined fields', () => {
      const state = createMinimalState();
      const result = extractPersistedState(state);
      expect(result).toEqual({
        currentAgent: undefined,
        currentModel: undefined,
        currentModelDisplayName: undefined,
      });
    });
  });

  describe('round-trip (save → hydrate)', () => {
    it('full round-trip: save then load simulates extension reload', () => {
      // Simulate first session: user selects agent and model
      const session1State = createMinimalState({
        currentAgent: 'coder',
        currentModel: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
        currentModelDisplayName: 'Claude Sonnet 4',
      });

      // Persist
      savePersistedSettingsState(context, extractPersistedState(session1State));

      // Simulate extension reload: new ExtensionState, no values set
      const session2State = createMinimalState();

      // Hydrate from persistence (same as on activation)
      hydrateStateFromPersisted(context, session2State);

      // Verify selections survived the reload
      expect(session2State.currentAgent).toBe('coder');
      expect(session2State.currentModel).toEqual({
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4',
      });
      expect(session2State.currentModelDisplayName).toBe('Claude Sonnet 4');
    });

    it('new selection after reload overwrites old persisted state', () => {
      // Persist initial selection
      savePersistedSettingsState(context, {
        currentAgent: 'old-agent',
        currentModel: { providerID: 'openai', modelID: 'gpt-4' },
        currentModelDisplayName: 'GPT-4',
      });

      // Simulate reload: hydrate then change selection
      const state = createMinimalState();
      hydrateStateFromPersisted(context, state);

      // User changes selection
      state.currentAgent = 'new-agent';
      state.currentModel = { providerID: 'anthropic', modelID: 'claude-3' };
      state.currentModelDisplayName = 'Claude 3';

      // Persist new selection
      savePersistedSettingsState(context, extractPersistedState(state));

      // Verify new selection is persisted
      const loaded = loadPersistedSettingsState(context);
      expect(loaded).toEqual({
        currentAgent: 'new-agent',
        currentModel: { providerID: 'anthropic', modelID: 'claude-3' },
        currentModelDisplayName: 'Claude 3',
      });
    });
  });
});
