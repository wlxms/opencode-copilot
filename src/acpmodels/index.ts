/**
 * ACPModels — bidirectional model registry bridging Copilot and ACP backends.
 *
 * Architecture:
 *   Layer 1 — ACP Backend models (what each backend provides)
 *   Layer 2 — Copilot models (what VS Code already knows about)
 *   Layer 3 — ACPModels provider mapping (which providers are bridged)
 *
 * Exposure rule:
 *   If a backend model IS in Copilot AND has a supported mapping → hidden.
 *   If a backend model is NOT in Copilot AND has a supported mapping → exposed.
 *
 * Resolution is always done against the FULL model set so session-target
 * picks work regardless of exposure state.
 *
 * @module
 */

import * as vscode from 'vscode';
import type { AcpBackend } from '../acp/backend';
import { AuthReader } from './auth-reader';
import { runSync, applyInjections } from './sync-engine';
import { resolve as resolveModel } from './resolver';
import { enumerateCopilotModels } from './copilot-reader';
import { providerRegistry } from './provider-registry';
import type {
  SyncResult,
  CopilotModelRegistration,
  ResolutionResult,
} from './types';

// ===========================================================================
// Public interface
// ===========================================================================

export interface AcpModels {
  /** Run full bidirectional sync (enumerate → normalise → diff) */
  sync(): Promise<void>;

  /**
   * Resolve a Copilot model reference (vendor + id) to a backend route.
   * Uses the FULL model set including Copilot-side entries so session-target
   * picks always find their match.
   */
  resolve(copilotVendor: string, copilotModelId: string): ResolutionResult;

  /**
   * Models to expose via vscode.lm provider.
   * Backend models already in Copilot are excluded (Layer 1 ∩ Layer 2 filter).
   * Only models with a supported mapping (Layer 3) are included.
   */
  getModelsForExposure(): CopilotModelRegistration[];

  /** Trigger re-sync */
  refresh(): Promise<void>;

  /** Dispose cached state */
  dispose(): void;
}

// ===========================================================================
// Factory
// ===========================================================================

export interface CreateAcpModelsOptions {
  backends: Map<string, AcpBackend>;
  authReader: AuthReader;
  logger: vscode.OutputChannel;
}

export function createAcpModels(opts: CreateAcpModelsOptions): AcpModels {
  let lastSync: SyncResult | null = null;
  let copilotModelIds: Set<string> = new Set();

  const { backends, authReader, logger } = opts;

  const instance: AcpModels = {
    async sync(): Promise<void> {
      await authReader.load();

      // ── Layer 2: cache Copilot-side model IDs ─────────
      try {
        const cpModels = await enumerateCopilotModels();
        copilotModelIds = new Set(cpModels.map((m) => `${m.vendor}/${m.id}`));
        logger.appendLine(`[acpmodels] Cached ${copilotModelIds.size} Copilot model IDs`);
      } catch {
        copilotModelIds = new Set();
      }

      // ── Full sync (Layer 1 + 3) ─────────────────────
      const result = await runSync({ backends, authReader, logger });
      await applyInjections(result.providersToInject, backends, logger);
      lastSync = result;
    },

    resolve(copilotVendor: string, copilotModelId: string): ResolutionResult {
      if (!lastSync) return { kind: 'not-found' };
      return resolveModel(lastSync.allModels, copilotVendor, copilotModelId);
    },

    getModelsForExposure(): CopilotModelRegistration[] {
      if (!lastSync) return [];

      const registrations: CopilotModelRegistration[] = [];
      const seen = new Set<string>();

      for (const model of lastSync.allModels) {
        for (const bp of model.backendPresence) {
          const key = `${bp.backendId}/${bp.providerID}/${model.modelId}`;
          if (seen.has(key)) continue;
          seen.add(key);

          // Build candidate Copilot-style keys for dedup
          const directKey = `${bp.providerID}/${model.modelId}`;
          const aliasKey = model.copilotVendor
            ? `${model.copilotVendor}/${model.copilotModelId ?? model.modelId}`
            : directKey;

          const existsInCopilot =
            copilotModelIds.has(directKey) ||
            copilotModelIds.has(aliasKey) ||
            copilotModelIds.has(model.modelId);

          // Layer 3: only expose if provider config table supports this mapping
          const meta = providerRegistry.get(model.providerMetaId);
          const hasSupportedMapping = !!meta;

          if (!existsInCopilot && hasSupportedMapping) {
            registrations.push({
              vendor: bp.providerID,
              modelId: model.modelId,
              displayName: model.displayName,
              maxInputTokens: model.maxInputTokens,
              maxOutputTokens: model.maxOutputTokens,
              capabilities: model.capabilities,
              sessionOnly: false,
            });
          }
        }
      }

      logger.appendLine(
        `[acpmodels] Exposure: ${registrations.length} models ` +
        `(Copilot had ${copilotModelIds.size}, sync had ${lastSync.allModels.length})`,
      );
      return registrations;
    },

    async refresh(): Promise<void> {
      await instance.sync();
    },

    dispose(): void {
      lastSync = null;
      copilotModelIds.clear();
    },
  };

  return instance;
}
