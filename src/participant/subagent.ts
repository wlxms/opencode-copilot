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
  /** True once the child session AND all its descendants have emitted session.idle */
  childIdle?: boolean;
  /**
   * Unique ID for this subagent invocation — set at task:completed when the
   * subagent is truly created. Passed to beginToolInvocation for child tools
   * so VSCode groups them under the parent subagent card.
   */
  subAgentInvocationId?: string;
  /** Task tool metadata captured at task:running — used to build final card at session.idle */
  toolMeta?: {
    toolName: string;
    title: string;
    input: Record<string, unknown>;
    timeStart?: number;
  };
  /** Task tool output captured at task:completed */
  output?: string;
  /** Wall-clock time when the subagent truly finished (child session.idle) */
  timeEnd?: number;
  /**
   * Set of descendant session IDs (child, grandchild, etc.).
   * Used to track which sessions belong to this subagent so that
   * grandchild events can be routed to the correct scope and
   * completion propagates upward correctly.
   */
  descendantSessionIds: Set<string>;
  /**
   * Last meaningful LLM text output from the subagent's child session.
   * Collected throughout the subagent lifecycle and used as the summary
   * when the subagent completes.
   */
  lastText?: string;
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
  if (counts.size === 0) {return '';}
  const parts: string[] = [];
  for (const [name, count] of counts) {
    parts.push(count > 1 ? `${count}× ${name}` : name);
  }
  return parts.join(', ');
}
