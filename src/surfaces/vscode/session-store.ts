/**
 * Provider-owned session store for the experimental VS Code chat surface.
 *
 * Separates three distinct identity layers that were previously conflated in
 * `ExtensionState.sessionMap`:
 *
 *  1. **Resource identity**  — the `vscode.Uri` VS Code uses to identify a
 *     chat tab (e.g. `opencode-copilot.opencode:/untitled-xxx`).
 *  2. **Provider session**   — an opaque logical session ID owned by this
 *     extension. Generated on first use, stable across tab switches, and
 *     persisted via `workspaceState` for workspace lifetime.
 *  3. **Backend session**    — the OpenCode daemon's session ID (e.g.
 *     `ses_xxx`). Bound lazily when the first prompt is sent to the daemon.
 *
 * == Lifecycle ==
 * ```
 * untitled/new resource
 *   → resolve() returns placeholder (empty history, no backend session)
 *   → first prompt calls bindBackendSession(providerId, backendId)
 *   → subsequent prompts reuse the bound backend session
 *
 * explicit ses_xxx resource (history item from controller)
 *   → resolve() returns bound session (restores from backend)
 *   → bindBackendSession() called during resolve with the known backend ID
 * ```
 *
 * == Persistence ==
 * The `resource→provider` and `provider→backend` mappings are persisted to
 * `workspaceState` as a single JSON blob. This survives tab switches within a
 * workspace session but is discarded when the workspace closes — matching the
 * UX expectation that a fresh workspace starts with a clean slate.
 *
 * @module
 */

import * as vscode from 'vscode';
import type { ExtensionState, SessionState } from '../../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A resolved session — the store's answer to "what session lives here?".
 */
export interface ResolvedSession {
  /** Our provider-owned logical session ID */
  providerSessionId: string;
  /** The backend session ID, if one has been bound. `undefined` = placeholder. */
  backendSessionId: string | undefined;
  /** Whether this is a fresh placeholder (never prompted) */
  isPlaceholder: boolean;
}

export interface ProviderSessionMeta {
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  /** Per-session agent selection (session-scoped picker state) */
  currentAgent?: string;
  /** Per-session model selection (session-scoped picker state) */
  currentModel?: { providerID: string; modelID: string };
  /** Per-session model display name (session-scoped picker state) */
  currentModelDisplayName?: string;
}

/**
 * Serializable shape persisted to workspaceState.
 * Two maps: resource string → provider ID, provider ID → backend ID.
 */
interface SessionStoreState {
  /** Map from resource URI string → provider session ID */
  resourceToProvider: Record<string, string>;
  /** Map from provider session ID → backend session ID (empty string = unbound) */
  providerToBackend: Record<string, string>;
  /** Map from provider session ID → persisted metadata */
  providerMeta: Record<string, ProviderSessionMeta>;
  /** Ordered list of provider session IDs for controller item derivation */
  recentProviderIds: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_KEY = 'opencode.sessionStore.v1';

// ---------------------------------------------------------------------------
// OpenCodeSessionStore
// ---------------------------------------------------------------------------

/**
 * Provider-owned session store.
 *
 * Owns the mapping between VS Code resource URIs, provider logical session IDs,
 * and OpenCode backend session IDs. Used exclusively by the experimental
 * chat session surface — the stable participant surface continues to use
 * `ExtensionState.sessionMap` directly.
 */
export class OpenCodeSessionStore {
  private readonly resourceToProvider = new Map<string, string>();
  private readonly providerToBackend = new Map<string, string>();
  private readonly providerMeta = new Map<string, ProviderSessionMeta>();
  /** Tracks recently active provider IDs for controller item ordering. */
  private readonly recentProviderIds: string[] = [];
  private readonly logger: { appendLine(m: string): void };
  private readonly memento: vscode.Memento;

  constructor(
    memento: vscode.Memento,
    logger: { appendLine(m: string): void },
  ) {
    this.memento = memento;
    this.logger = logger;
    this.loadFromMemento();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Resolve a VS Code resource URI to a session record.
   *
   * - If the resource has been seen before, returns its existing mapping.
   * - If the resource is new/untitled, creates a placeholder provider session.
   * - If the resource URI contains a known backend session ID (e.g. `ses_xxx`),
   *   binds it immediately.
   */
  resolve(resource: vscode.Uri): ResolvedSession {
    const resourceKey = resource.toString();

    // 1. Existing mapping?
    const existingProviderId = this.resourceToProvider.get(resourceKey);
    if (existingProviderId) {
      const backendId = this.providerToBackend.get(existingProviderId);
      return {
        providerSessionId: existingProviderId,
        backendSessionId: backendId || undefined,
        isPlaceholder: !backendId,
      };
    }

    // 2. Extract session ID from URI path — could be a backend ID (ses_xxx)
    //    or a synthetic ID (new-*, untitled-*, empty).
    const pathId = this.extractPathId(resource);

    // 3. Create new provider session ID
    const providerSessionId = this.generateProviderSessionId();

    // 4. If the path contains a real backend ID, bind immediately.
    // Reuse an existing provider session if that backend session is already known.
    if (pathId && this.isBackendSessionId(pathId)) {
      const existingProviderId = this.getProviderSessionIdByBackend(pathId);
      if (existingProviderId) {
        this.resourceToProvider.set(resourceKey, existingProviderId);
        this.touchRecent(existingProviderId);
        this.persist();
        this.logger.appendLine(
          `[session-store] resolve: aliased backend resource=${resourceKey} to existing provider=${existingProviderId}`,
        );
        return {
          providerSessionId: existingProviderId,
          backendSessionId: pathId,
          isPlaceholder: false,
        };
      }

      this.resourceToProvider.set(resourceKey, providerSessionId);
      this.providerToBackend.set(providerSessionId, pathId);
      this.providerMeta.set(providerSessionId, {
        ...this.providerMeta.get(providerSessionId),
        updatedAt: Date.now(),
      });
      this.touchRecent(providerSessionId);
      this.persist();
      this.logger.appendLine(
        `[session-store] resolve: created provider=${providerSessionId}, bound backend=${pathId} for resource=${resourceKey}`,
      );
      return {
        providerSessionId,
        backendSessionId: pathId,
        isPlaceholder: false,
      };
    }

    // 5. Check if another resource already maps to this same pathId
    //    (e.g. user opened a history item twice — reuse the provider session)
    if (pathId) {
      for (const [existingKey, existingPid] of this.resourceToProvider) {
        const existingPath = this.extractPathId(vscode.Uri.parse(existingKey));
        if (existingPath === pathId) {
          // Found a match — alias this resource to the same provider session
          this.resourceToProvider.set(resourceKey, existingPid);
          const backendId = this.providerToBackend.get(existingPid);
          this.logger.appendLine(
            `[session-store] resolve: aliased resource=${resourceKey} to existing provider=${existingPid}`,
          );
          return {
            providerSessionId: existingPid,
            backendSessionId: backendId || undefined,
            isPlaceholder: !backendId,
          };
        }
      }
    }

    // 6. New placeholder
    this.resourceToProvider.set(resourceKey, providerSessionId);
    this.providerToBackend.set(providerSessionId, ''); // empty = unbound
    this.providerMeta.set(providerSessionId, {
      ...this.providerMeta.get(providerSessionId),
      updatedAt: Date.now(),
    });
    this.touchRecent(providerSessionId);
    this.persist();
    this.logger.appendLine(
      `[session-store] resolve: created placeholder provider=${providerSessionId} for resource=${resourceKey}`,
    );
    return {
      providerSessionId,
      backendSessionId: undefined,
      isPlaceholder: true,
    };
  }

  /**
   * Bind a backend session ID to a provider session.
   * Called when the first prompt creates a backend session on the daemon.
   */
  bindBackendSession(providerSessionId: string, backendSessionId: string, meta?: Partial<ProviderSessionMeta>): void {
    const previous = this.providerToBackend.get(providerSessionId);
    this.providerToBackend.set(providerSessionId, backendSessionId);
    this.providerMeta.set(providerSessionId, {
      ...this.providerMeta.get(providerSessionId),
      ...meta,
      updatedAt: Date.now(),
    });
    this.touchRecent(providerSessionId);
    this.persist();
    this.logger.appendLine(
      `[session-store] bindBackendSession: provider=${providerSessionId} → backend=${backendSessionId} (was ${previous || '(none)'})`,
    );
  }

  /**
   * Get the backend session ID for a provider session, if bound.
   */
  getBackendSessionId(providerSessionId: string): string | undefined {
    const id = this.providerToBackend.get(providerSessionId);
    return id || undefined;
  }

  /**
   * Get the backend session ID for a VS Code resource URI, if bound.
   * Convenience method combining resolve + getBackendSessionId.
   */
  getBackendSessionIdForResource(resource: vscode.Uri): string | undefined {
    const resourceKey = resource.toString();
    const providerId = this.resourceToProvider.get(resourceKey);
    if (!providerId) { return undefined; }
    return this.getBackendSessionId(providerId);
  }

  /**
   * Look up the provider session ID for a VS Code resource URI.
   * Returns undefined if the resource is not tracked by this store.
   */
  getProviderSessionId(resource: vscode.Uri): string | undefined {
    return this.resourceToProvider.get(resource.toString());
  }

  getMeta(providerSessionId: string): ProviderSessionMeta | undefined {
    return this.providerMeta.get(providerSessionId);
  }

  /**
   * Update metadata for a provider session. Merges with existing metadata.
   * Persists immediately.
   */
  setMeta(providerSessionId: string, meta: Partial<ProviderSessionMeta>): void {
    const existing = this.providerMeta.get(providerSessionId) ?? {};
    this.providerMeta.set(providerSessionId, {
      ...existing,
      ...meta,
      updatedAt: Date.now(),
    });
    this.persist();
  }

  /**
   * Get metadata for a VS Code resource URI (convenience).
   * Returns undefined if the resource is not tracked.
   */
  getMetaForResource(resource: vscode.Uri): ProviderSessionMeta | undefined {
    const providerId = this.resourceToProvider.get(resource.toString());
    if (!providerId) { return undefined; }
    return this.providerMeta.get(providerId);
  }

  linkResource(resource: vscode.Uri, providerSessionId: string): void {
    this.resourceToProvider.set(resource.toString(), providerSessionId);
    this.touchRecent(providerSessionId);
    this.persist();
  }

  /**
   * Look up the provider session ID by backend session ID.
   * Used by the controller to find provider sessions for known backend sessions.
   */
  getProviderSessionIdByBackend(backendSessionId: string): string | undefined {
    for (const [providerId, backendId] of this.providerToBackend) {
      if (backendId === backendSessionId) {
        return providerId;
      }
    }
    return undefined;
  }

  /**
   * Get all known backend-bound sessions for controller item derivation.
   * Returns sessions sorted by most-recently-active first.
   * Only includes sessions that have a bound backend session ID.
   */
  getBoundSessions(): Array<{ providerSessionId: string; backendSessionId: string; meta?: ProviderSessionMeta }> {
    const result: Array<{ providerSessionId: string; backendSessionId: string; meta?: ProviderSessionMeta }> = [];
    // Iterate in recent-first order
    for (const providerId of this.recentProviderIds) {
      const backendId = this.providerToBackend.get(providerId);
      if (backendId) {
        result.push({ providerSessionId: providerId, backendSessionId: backendId, meta: this.providerMeta.get(providerId) });
      }
    }
    // Also include any bound sessions not in the recent list
    for (const [providerId, backendId] of this.providerToBackend) {
      if (backendId && !this.recentProviderIds.includes(providerId)) {
        result.push({ providerSessionId: providerId, backendSessionId: backendId, meta: this.providerMeta.get(providerId) });
      }
    }
    return result;
  }

  /**
   * Sync a list of backend sessions (from the daemon) into the store.
   * For each backend session that doesn't have a provider mapping, creates
   * a provider-only entry. Returns sessions in a form suitable for controller
   * item creation.
   *
   * This is the bridge between "raw backend list" and "store-derived items".
   */
  syncBackendSessions(
    backendSessions: Array<{ id: string; title?: string; createdAt?: Date }>,
  ): Array<{ backendSessionId: string; providerSessionId: string; title?: string; createdAt?: Date; isNew: boolean }> {
    const result: Array<{ backendSessionId: string; providerSessionId: string; title?: string; createdAt?: Date; isNew: boolean }> = [];

    for (const session of backendSessions) {
      // Find existing provider mapping
      let providerId = this.getProviderSessionIdByBackend(session.id);
      let isNew = false;

      if (!providerId) {
        // Backend session not in store — create a provider entry
        providerId = this.generateProviderSessionId();
        this.providerToBackend.set(providerId, session.id);
        this.touchRecent(providerId);
        isNew = true;
      }

      const existingMeta = this.providerMeta.get(providerId) ?? {};
      this.providerMeta.set(providerId, {
        ...existingMeta,
        title: session.title ?? existingMeta.title,
        createdAt: session.createdAt ? session.createdAt.getTime() : existingMeta.createdAt,
        updatedAt: Date.now(),
      });

      result.push({
        backendSessionId: session.id,
        providerSessionId: providerId,
        title: session.title ?? existingMeta.title,
        createdAt: session.createdAt ?? (existingMeta.createdAt ? new Date(existingMeta.createdAt) : undefined),
        isNew,
      });
    }

    if (result.length > 0) {
      this.persist();
    }

    return result;
  }

  /**
   * Export the store's backend mapping into the legacy `SessionState` format
   * for compatibility with code that still reads from `ExtensionState.sessionMap`.
   *
   * @param vscodeSessionKey - The key used in sessionMap (usually request.sessionId or resource.toString())
   * @param providerSessionId - The provider session ID to look up
   */
  toLegacySessionState(vscodeSessionKey: string, providerSessionId: string): SessionState {
    const backendId = this.providerToBackend.get(providerSessionId) || '';
    return {
      opencodeSessionId: backendId,
      turnMap: [],
    };
  }

  /**
   * Set the legacy sessionMap entry from a resolved session, maintaining
   * backward compatibility with the stable participant handler.
   */
  syncToLegacySessionMap(
    state: ExtensionState,
    vscodeSessionKey: string,
    resolved: ResolvedSession,
  ): void {
    state.sessionMap.set(vscodeSessionKey, {
      opencodeSessionId: resolved.backendSessionId ?? '',
      turnMap: [],
    });
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  private persist(): void {
    const snapshot: SessionStoreState = {
      resourceToProvider: Object.fromEntries(this.resourceToProvider),
      providerToBackend: Object.fromEntries(this.providerToBackend),
      providerMeta: Object.fromEntries(this.providerMeta),
      recentProviderIds: this.recentProviderIds.slice(0, 50), // cap at 50
    };
    this.memento.update(STATE_KEY, snapshot).then(undefined, (err: unknown) => {
      this.logger.appendLine(
        `[session-store] Failed to persist state: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private loadFromMemento(): void {
    const snapshot = this.memento.get<SessionStoreState>(STATE_KEY);
    if (!snapshot) { return; }

    try {
      if (snapshot.resourceToProvider) {
        for (const [k, v] of Object.entries(snapshot.resourceToProvider)) {
          this.resourceToProvider.set(k, v);
        }
      }
      if (snapshot.providerToBackend) {
        for (const [k, v] of Object.entries(snapshot.providerToBackend)) {
          this.providerToBackend.set(k, v);
        }
      }
      if (snapshot.providerMeta) {
        for (const [k, v] of Object.entries(snapshot.providerMeta)) {
          this.providerMeta.set(k, v);
        }
      }
      if (snapshot.recentProviderIds) {
        this.recentProviderIds.push(...snapshot.recentProviderIds);
      }
      this.logger.appendLine(
        `[session-store] Loaded ${this.resourceToProvider.size} resource mappings, ` +
        `${this.providerToBackend.size} provider mappings from workspaceState`,
      );
    } catch (err) {
      this.logger.appendLine(
        `[session-store] Failed to load state: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private touchRecent(providerSessionId: string): void {
    const idx = this.recentProviderIds.indexOf(providerSessionId);
    if (idx >= 0) {
      this.recentProviderIds.splice(idx, 1);
    }
    this.recentProviderIds.unshift(providerSessionId);
  }

  private extractPathId(resource: vscode.Uri): string {
    const path = resource.path;
    return path.startsWith('/') ? path.slice(1) : path;
  }

  private isBackendSessionId(id: string): boolean {
    return id.startsWith('ses_');
  }

  private generateProviderSessionId(): string {
    return `ps_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
