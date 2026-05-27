import { describe, it, expect, beforeEach } from 'vitest';
import * as vscode from 'vscode';

import { OpenCodeSessionStore } from '../surfaces/vscode/session-store';

class TestMemento {
  private readonly values = new Map<string, unknown>();

  keys(): readonly string[] {
    return Array.from(this.values.keys());
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T | undefined;
  }

  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

describe('OpenCodeSessionStore', () => {
  let logger: vscode.OutputChannel;
  let memento: TestMemento;

  beforeEach(() => {
    logger = vscode.window.createOutputChannel('test');
    memento = new TestMemento();
  });

  it('creates placeholder session for untitled resource', () => {
    const store = new OpenCodeSessionStore(memento as unknown as vscode.Memento, logger);

    const resolved = store.resolve(vscode.Uri.parse('opencode-copilot.opencode:/untitled-123'));

    expect(resolved.isPlaceholder).toBe(true);
    expect(resolved.backendSessionId).toBeUndefined();
    expect(resolved.providerSessionId.startsWith('ps_')).toBe(true);
  });

  it('binds placeholder to backend session and aliases backend resource', () => {
    const store = new OpenCodeSessionStore(memento as unknown as vscode.Memento, logger);
    const untitled = vscode.Uri.parse('opencode-copilot.opencode:/untitled-123');

    const resolved = store.resolve(untitled);
    store.bindBackendSession(resolved.providerSessionId, 'ses_abc123', { title: 'Bound Chat' });
    store.linkResource(vscode.Uri.parse('opencode-copilot.opencode:/ses_abc123'), resolved.providerSessionId);

    expect(store.getBackendSessionId(resolved.providerSessionId)).toBe('ses_abc123');
    expect(store.getProviderSessionId(vscode.Uri.parse('opencode-copilot.opencode:/ses_abc123'))).toBe(resolved.providerSessionId);
    expect(store.getMeta(resolved.providerSessionId)?.title).toBe('Bound Chat');
  });

  it('reuses existing provider session when resolving known backend resource', () => {
    const store = new OpenCodeSessionStore(memento as unknown as vscode.Memento, logger);
    const first = store.resolve(vscode.Uri.parse('opencode-copilot.opencode:/untitled-123'));

    store.bindBackendSession(first.providerSessionId, 'ses_existing');
    store.linkResource(vscode.Uri.parse('opencode-copilot.opencode:/ses_existing'), first.providerSessionId);

    const second = store.resolve(vscode.Uri.parse('opencode-copilot.opencode:/ses_existing'));

    expect(second.providerSessionId).toBe(first.providerSessionId);
    expect(second.backendSessionId).toBe('ses_existing');
    expect(second.isPlaceholder).toBe(false);
  });

  it('persists metadata and mappings through memento reload', () => {
    const store1 = new OpenCodeSessionStore(memento as unknown as vscode.Memento, logger);
    const resolved = store1.resolve(vscode.Uri.parse('opencode-copilot.opencode:/untitled-123'));
    store1.bindBackendSession(resolved.providerSessionId, 'ses_reload', { title: 'Reloaded', createdAt: 42 });
    store1.linkResource(vscode.Uri.parse('opencode-copilot.opencode:/ses_reload'), resolved.providerSessionId);

    const store2 = new OpenCodeSessionStore(memento as unknown as vscode.Memento, logger);
    const again = store2.resolve(vscode.Uri.parse('opencode-copilot.opencode:/ses_reload'));

    expect(again.providerSessionId).toBe(resolved.providerSessionId);
    expect(store2.getMeta(resolved.providerSessionId)?.title).toBe('Reloaded');
    expect(store2.getMeta(resolved.providerSessionId)?.createdAt).toBe(42);
  });

  it('syncs backend sessions into provider-owned metadata', () => {
    const store = new OpenCodeSessionStore(memento as unknown as vscode.Memento, logger);

    const synced = store.syncBackendSessions([
      { id: 'ses_one', title: 'Session One', createdAt: new Date('2026-01-01T00:00:00Z') },
    ]);

    expect(synced).toHaveLength(1);
    expect(synced[0].title).toBe('Session One');
    expect(synced[0].isNew).toBe(true);
    expect(store.getMeta(synced[0].providerSessionId)?.title).toBe('Session One');
    expect(store.getBoundSessions()[0]?.backendSessionId).toBe('ses_one');
  });

  // -----------------------------------------------------------------------
  // setMeta / getMetaForResource
  // -----------------------------------------------------------------------

  it('setMeta merges metadata and persists', () => {
    const store = new OpenCodeSessionStore(memento as unknown as vscode.Memento, logger);
    const resolved = store.resolve(vscode.Uri.parse('opencode-copilot.opencode:/untitled-setMeta'));

    store.setMeta(resolved.providerSessionId, { title: 'Hello' });
    expect(store.getMeta(resolved.providerSessionId)?.title).toBe('Hello');

    // Merge additional fields
    store.setMeta(resolved.providerSessionId, { currentAgent: 'coder' });
    expect(store.getMeta(resolved.providerSessionId)?.title).toBe('Hello');
    expect(store.getMeta(resolved.providerSessionId)?.currentAgent).toBe('coder');
  });

  it('setMeta persists picker state through memento reload', () => {
    const store1 = new OpenCodeSessionStore(memento as unknown as vscode.Memento, logger);
    const resolved = store1.resolve(vscode.Uri.parse('opencode-copilot.opencode:/untitled-persist'));
    store1.setMeta(resolved.providerSessionId, {
      currentAgent: 'planner',
      currentModel: { providerID: 'openai', modelID: 'gpt-4' },
      currentModelDisplayName: 'GPT-4',
    });

    const store2 = new OpenCodeSessionStore(memento as unknown as vscode.Memento, logger);
    const again = store2.resolve(vscode.Uri.parse('opencode-copilot.opencode:/untitled-persist'));
    const meta = store2.getMeta(again.providerSessionId);

    expect(meta?.currentAgent).toBe('planner');
    expect(meta?.currentModel).toEqual({ providerID: 'openai', modelID: 'gpt-4' });
    expect(meta?.currentModelDisplayName).toBe('GPT-4');
  });

  it('getMetaForResource returns metadata for a tracked resource', () => {
    const store = new OpenCodeSessionStore(memento as unknown as vscode.Memento, logger);
    const resource = vscode.Uri.parse('opencode-copilot.opencode:/untitled-metaForResource');
    const resolved = store.resolve(resource);

    store.setMeta(resolved.providerSessionId, { currentAgent: 'reviewer' });

    const meta = store.getMetaForResource(resource);
    expect(meta?.currentAgent).toBe('reviewer');
  });

  it('getMetaForResource returns undefined for unknown resource', () => {
    const store = new OpenCodeSessionStore(memento as unknown as vscode.Memento, logger);
    const meta = store.getMetaForResource(vscode.Uri.parse('opencode-copilot.opencode:/unknown'));
    expect(meta).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Per-session picker state isolation
  // -----------------------------------------------------------------------

  it('different sessions have independent picker state', () => {
    const store = new OpenCodeSessionStore(memento as unknown as vscode.Memento, logger);

    const res1 = store.resolve(vscode.Uri.parse('opencode-copilot.opencode:/session-A'));
    const res2 = store.resolve(vscode.Uri.parse('opencode-copilot.opencode:/session-B'));

    store.setMeta(res1.providerSessionId, {
      currentAgent: 'agent-a',
      currentModel: { providerID: 'p1', modelID: 'm1' },
      currentModelDisplayName: 'Model One',
    });
    store.setMeta(res2.providerSessionId, {
      currentAgent: 'agent-b',
      currentModel: { providerID: 'p2', modelID: 'm2' },
      currentModelDisplayName: 'Model Two',
    });

    const meta1 = store.getMeta(res1.providerSessionId);
    const meta2 = store.getMeta(res2.providerSessionId);

    expect(meta1?.currentAgent).toBe('agent-a');
    expect(meta1?.currentModel?.modelID).toBe('m1');
    expect(meta2?.currentAgent).toBe('agent-b');
    expect(meta2?.currentModel?.modelID).toBe('m2');
  });

  // -----------------------------------------------------------------------
  // toLegacySessionState / syncToLegacySessionMap
  // -----------------------------------------------------------------------

  it('syncToLegacySessionMap mirrors store binding to sessionMap', () => {
    const store = new OpenCodeSessionStore(memento as unknown as vscode.Memento, logger);
    const resource = vscode.Uri.parse('opencode-copilot.opencode:/untitled-legacy');
    const resolved = store.resolve(resource);
    store.bindBackendSession(resolved.providerSessionId, 'ses_legacy123');
    // Re-resolve to get updated backendSessionId
    const boundResolved = store.resolve(resource);

    const fakeState = { sessionMap: new Map() } as any;
    store.syncToLegacySessionMap(fakeState, 'chat-key', boundResolved);

    expect(fakeState.sessionMap.get('chat-key').opencodeSessionId).toBe('ses_legacy123');
  });
});
