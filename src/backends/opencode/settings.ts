/**
 * OpenCode backend settings provider.
 *
 * Translates the current hardcoded OpenCode settings UI into a
 * declarative `BackendSettingsDescriptor` that the generic panel can render.
 */

import type { BackendSettingsProvider } from '../../acp/backend';
import type {
  AcpAgent,
  AcpModel,
  BackendSettingsDescriptor,
  SettingsFieldGroup,
  TextField,
  SelectField,
  MapField,
} from '../../acp/types';
import type { AcpConfigOperations } from '../../acp/backend';

export class OpenCodeSettingsProvider implements BackendSettingsProvider {
  constructor(private readonly configOps: AcpConfigOperations) {}

  async getDescriptor(agents: AcpAgent[], models: AcpModel[]): Promise<BackendSettingsDescriptor> {
    const configResp = await this.configOps.get();
    const rawConfig = (configResp.data ?? {}) as Record<string, unknown>;

    const visibleAgents = agents.filter(a => !a.hidden);
    const modelOptions = models.map(m => ({
      value: m.id,
      label:
        (m.name || m.id) +
        (m.providerName ? ` (${m.providerName})` : m.provider ? ` (${m.provider})` : ''),
    }));

    // ── Override tab ──────────────────────────────────────────────────────
    const overrideGroups: SettingsFieldGroup[] = [
      {
        key: 'global',
        fields: [
          {
            type: 'text',
            key: 'model',
            label: 'Global Default Model',
            description: 'Fallback model for all agents',
            placeholder: 'e.g., gpt-4o',
          } satisfies TextField,
          {
            type: 'text',
            key: 'small_model',
            label: 'Small Model',
            description: 'Lightweight model for quick tasks',
            placeholder: 'e.g., gpt-4o-mini',
          } satisfies TextField,
        ],
      },
    ];

    // Agent overrides — collapsible "Override" section
    if (visibleAgents.length > 0) {
      overrideGroups.push({
        key: 'agent-overrides',
        title: 'Override',
        collapsible: true,
        fields: [
          {
            type: 'map',
            key: 'agent',
            label: 'Per-Agent Settings',
            description: 'Override model and description for individual agents',
            items: visibleAgents.map(a => ({
              id: a.id,
              label: a.name || a.id,
              description: a.description,
            })),
            fields: [
              {
                type: 'select',
                key: 'model',
                label: 'Model Override',
                description: 'Per-agent model override',
                options: [{ value: '', label: '(use global default)' }, ...modelOptions],
              } satisfies SelectField,
              {
                type: 'text',
                key: 'description',
                label: 'Description',
                description: 'Optional agent-specific description',
                placeholder: 'Agent description',
              } satisfies TextField,
            ],
          } satisfies MapField,
        ],
      });
    }

    // ── Tabs ─────────────────────────────────────────────────────────────
    const tabs: BackendSettingsDescriptor['tabs'] = [
      { id: 'override', title: 'Setting', groups: overrideGroups },
      { id: 'provider', title: 'Provider', groups: [] },
    ];

    // ── Values ────────────────────────────────────────────────────────────
    const values: Record<string, unknown> = {};
    if (rawConfig.model) { values.model = rawConfig.model; }
    if (rawConfig.small_model) { values.small_model = rawConfig.small_model; }

    const agentConfig = rawConfig.agent as Record<string, Record<string, string>> | undefined;
    if (agentConfig && typeof agentConfig === 'object') {
      values.agent = agentConfig;
    }

    return { tabs, values };
  }

  async saveValues(values: Record<string, unknown>): Promise<void> {
    await this.configOps.update(values);
  }
}
