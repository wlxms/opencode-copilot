/**
 * SubagentManager + SubagentScope + formatSubagentProgress.
 *
 * Fully owned by SSP — no dependency on participant layer.
 * The participant layer and Bridge import FROM here, not the reverse.
 */

// ===========================================================================
// SubagentScope — tracks a running subagent's captured internal events
// ===========================================================================

export interface SubagentScope {
  callId: string;
  toolCalls: Array<{ name: string; title?: string; status: string }>;
  completed: boolean;
  childSessionId?: string;
  childIdle?: boolean;
  subAgentInvocationId?: string;
  parentSubAgentInvocationId?: string;
  toolMeta?: {
    toolName: string;
    title: string;
    input: Record<string, unknown>;
    timeStart?: number;
  };
  output?: string;
  timeEnd?: number;
  descendantSessionIds: Set<string>;
  lastText?: string;
}

// ===========================================================================
// formatSubagentProgress — human-readable subagent activity summary
// ===========================================================================

/** e.g. "3× read, 2× edit, bash" */
export function formatSubagentProgress(scope: SubagentScope): string {
  const counts = new Map<string, number>();
  for (const tc of scope.toolCalls) {
    if (tc.status === 'completed' || tc.status === 'error') {
      counts.set(tc.name, (counts.get(tc.name) ?? 0) + 1);
    }
  }
  if (counts.size === 0) { return ''; }
  const parts: string[] = [];
  for (const [name, count] of counts) {
    parts.push(count > 1 ? `${count}× ${name}` : name);
  }
  return parts.join(', ');
}

// ===========================================================================
// SubagentManager — runtime subagent state tracker
// ===========================================================================

export class SubagentManager {
  private scopes = new Map<string, SubagentScope>();

  startSubagent(
    callId: string,
    toolMeta: SubagentScope['toolMeta'],
    parentSubAgentInvocationId?: string,
  ): SubagentScope {
    const scope: SubagentScope = {
      callId,
      toolCalls: [],
      completed: false,
      descendantSessionIds: new Set(),
      subAgentInvocationId: this.generateSubAgentInvocationId(callId),
      parentSubAgentInvocationId,
      ...toolMeta ? { toolMeta } : {},
    };
    this.scopes.set(callId, scope);
    return scope;
  }

  recordChildToolCall(callId: string, toolCall: { name: string; title?: string; status: string }): void {
    const scope = this.scopes.get(callId);
    if (scope) { scope.toolCalls.push(toolCall); }
  }

  completeSubagent(callId: string, output?: string): SubagentScope | undefined {
    const scope = this.scopes.get(callId);
    if (scope) { scope.completed = true; if (output !== undefined) scope.output = output; }
    return scope;
  }

  markChildIdle(callId: string): void {
    const scope = this.scopes.get(callId);
    if (scope) { scope.childIdle = true; scope.timeEnd = Date.now(); }
  }

  setChildSession(callId: string, childSessionId: string): void {
    const scope = this.scopes.get(callId);
    if (scope) { scope.childSessionId = childSessionId; scope.descendantSessionIds.add(childSessionId); }
  }

  addDescendantSession(callId: string, sessionId: string): void {
    const scope = this.scopes.get(callId);
    if (scope) { scope.descendantSessionIds.add(sessionId); }
  }

  getScope(callId: string): SubagentScope | undefined { return this.scopes.get(callId); }

  hasBusyDescendant(): boolean {
    for (const scope of this.scopes.values()) {
      if (!scope.completed || !scope.childIdle) { return true; }
    }
    return false;
  }

  generateSubAgentInvocationId(callId: string): string {
    return `subagent-${callId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  getProgressSummary(callId: string): string {
    const scope = this.scopes.get(callId);
    return scope ? formatSubagentProgress(scope) : '';
  }

  removeSubagent(callId: string): void { this.scopes.delete(callId); }
  clear(): void { this.scopes.clear(); }
}
