/**
 * Shared subagent scope tracking and progress formatting utilities.
 *
 * Both StreamBridge (streaming.ts) and AcpRenderer (acp-renderer.ts) use
 * identical logic for tracking subagent-internal tool events and formatting
 * a human-readable activity summary. This module centralizes the shared code.
 */

// ---------------------------------------------------------------------------
// SubagentScope — tracks a running subagent's captured internal events
// ---------------------------------------------------------------------------

export interface SubagentScope {
  callId: string;
  toolCalls: Array<{ name: string; title?: string; status: string }>;
  /** True once the parent session marks the task tool call as completed */
  completed: boolean;
  /** Child session ID (from task tool metadata), if available */
  childSessionId?: string;
  /** True once the child session has emitted session.idle */
  childIdle?: boolean;
}

// ---------------------------------------------------------------------------
// formatSubagentProgress — human-readable subagent activity summary
// ---------------------------------------------------------------------------

/**
 * Format a human-readable summary of subagent activity.
 * e.g. "3× read, 2× edit, bash"
 */
export function formatSubagentProgress(scope: SubagentScope): string {
  const counts = new Map<string, number>();
  for (const tc of scope.toolCalls) {
    if (tc.status === 'completed' || tc.status === 'error') {
      counts.set(tc.name, (counts.get(tc.name) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return '';
  const parts: string[] = [];
  for (const [name, count] of counts) {
    parts.push(count > 1 ? `${count}× ${name}` : name);
  }
  return parts.join(', ');
}
