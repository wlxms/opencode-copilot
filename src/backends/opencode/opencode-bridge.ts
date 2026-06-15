/**
 * OpenCodeBridge — translates ACP events to SSS push/update calls.
 *
 * Architecture (v2):
 * - Bridge does NOT touch the VS Code stream directly — SSS owns it
 * - Bridge only calls sss.push(ssp) / sss.update(id, data)
 * - SubagentManager stays in bridge for scope tracking
 * - Child session events route to sss.subsession(id)
 * - Permission/Question handled via SSP callback injection
 *
 * Replaces the old 1763-line bridge that directly called stream APIs.
 */

import type {
  AcpEvent,
  AcpPartUpdatedEvent,
  AcpPartDeltaEvent,
  AcpPermissionRequestEvent,
  AcpQuestionRequestEvent,
  AcpQuestionInfo,
  AcpToolPart,
  AcpToolState,
} from '../../acp/types';
import type { AcpBridge } from '../../acp/backend';
import type { SerializableSessionStream } from '../../acp/streaming/session-stream';
import type { SubsessionStream } from '../../acp/streaming/subsession-stream';
import { SubagentManager, formatSubagentProgress, type SubagentScope } from '../../ssp/impl/subagent';
import { AssistantTextSSP } from '../../ssp/impl/assistant-text';
import { ReasoningSSP } from '../../ssp/impl/reasoning';
import { ToolInvocationSSP } from '../../ssp/impl/tool-invocation';
import { ExternalEditSSP } from '../../ssp/impl/external-edit';
import { QuestionSSP } from '../../ssp/impl/question';
import { ChatQuestion, ChatQuestionType } from '../../types/vscode-proposed-additions';
import type { AcpBackend } from '../../acp/backend';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEventSessionId(event: AcpEvent): string | undefined {
  const e = event as Record<string, unknown>;
  return (e.sessionId as string | undefined) ??
    (e.part as { sessionId?: string } | undefined)?.sessionId;
}

function createExternalEditUri(filePath: string, directory?: string): unknown {
  // Dynamic import to avoid circular deps at module load
  const vscode = require('vscode');
  const baseDir = directory ?? '';
  const fullPath = vscode.workspace.asRelativePath
    ? vscode.Uri.file(filePath)
    : vscode.Uri.file(filePath);
  const rawUri = vscode.Uri.file(filePath);
  const normalizedPath = /^\/[a-zA-Z]:(?=\/)/.test(rawUri.path)
    ? rawUri.path.toLowerCase()
    : rawUri.path;
  return rawUri.path !== normalizedPath
    ? rawUri.with({ path: normalizedPath })
    : rawUri;
}

// ---------------------------------------------------------------------------
// OpenCodeBridge
// ---------------------------------------------------------------------------

interface BridgeLogger { appendLine(message: string): void; }

export class OpenCodeBridge implements AcpBridge {
  private sss!: SerializableSessionStream;
  private logger: BridgeLogger = { appendLine: () => {} };

  // Event state
  private userMessageId: string | null = null;
  private partKinds = new Map<string, 'text' | 'reasoning' | 'tool'>();
  private sessionTitle: string | undefined;
  private hadSubagentTasks = false;

  // Subagent management
  private subagents = new SubagentManager();

  // Deferred idle
  private deferredIdle = false;
  private static readonly DEFERRED_IDLE_TIMEOUT_MS = 120_000;
  private deferredIdleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly backend: AcpBackend,
    private readonly sessionId: string,
    private readonly directory?: string,
  ) {}

  setSSS(sss: unknown): void {
    this.sss = sss as SerializableSessionStream;
  }

  setLogger(logger: BridgeLogger): void {
    this.logger = logger;
    this.log = (msg: string) => logger.appendLine(`[bridge] ${msg}`);
  }

  private log: (msg: string) => void = () => {};
  private logTag(tag: string, msg: string): void { this.log(`[${tag}] ${msg}`); }

  // ════════════════════════════════════════════════════════════════════════
  // Event loop
  // ════════════════════════════════════════════════════════════════════════

  async run(events: AsyncIterable<AcpEvent>, token: { isCancellationRequested: boolean }): Promise<boolean> {
    try {
      for await (const event of events) {
        if (token.isCancellationRequested) break;
        this.handleEvent(event);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection lost';
      this.log(`bridge error: ${msg}`);
    }
    return !token.isCancellationRequested;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Event dispatch
  // ════════════════════════════════════════════════════════════════════════

  private handleEvent(event: AcpEvent): void {
    // 1. Check if this is a child/descendant session event
    const eventSessionId = getEventSessionId(event);
    if (eventSessionId && eventSessionId !== this.sessionId) {
      this.handleChildSessionEvent(event, eventSessionId);
      return;
    }

    // 2. Parent session events
    switch (event.type) {
      case 'part.updated':       this.handlePartUpdated(event); break;
      case 'part.delta':         this.handlePartDelta(event); break;
      case 'permission.asked':   this.handlePermissionAsked(event); break;
      case 'question.asked':     this.handleQuestionAsked(event); break;
      case 'session.updated':    this.handleSessionUpdated(event); break;
      case 'session.idle':       this.handleSessionIdle(); break;
      case 'session.diff':       this.handleSessionDiff(event); break;
      case 'session.status':     break; // log only
      default:                   break;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Append-only: text / reasoning deltas → always push
  // ════════════════════════════════════════════════════════════════════════

  private handlePartDelta(event: AcpPartDeltaEvent): void {
    if (!event.delta) return;
    const kind = this.partKinds.get(event.partId);
    if (kind === 'reasoning') {
      this.sss.push(new ReasoningSSP({ partId: event.partId, delta: event.delta }));
    } else {
      this.sss.push(new AssistantTextSSP({ partId: event.partId, delta: event.delta }));
    }
  }

  private handlePartUpdated(event: AcpPartUpdatedEvent): void {
    const part = event.part;
    switch (part.type) {
      case 'text': {
        // User echo detection: first text part's messageId = user message
        if (this.userMessageId === null && part.messageId) {
          this.userMessageId = part.messageId;
        }
        if (part.messageId && part.messageId === this.userMessageId) {
          this.partKinds.set(part.id, 'text');
          return; // Skip user echo
        }
        this.sss.push(new AssistantTextSSP({ partId: part.id, delta: part.text ?? '' }));
        this.partKinds.set(part.id, 'text');
        break;
      }
      case 'reasoning':
        this.sss.push(new ReasoningSSP({ partId: part.id, delta: part.text ?? '' }));
        this.partKinds.set(part.id, 'reasoning');
        break;
      case 'tool':
        this.handleToolState(part);
        break;
      case 'step-start':
      case 'step-finish':
        break; // No rendering needed
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Mutable: tool lifecycle → push (pending) / update (running/completed)
  // ════════════════════════════════════════════════════════════════════════

  private handleToolState(part: AcpToolPart): void {
    const key = part.callId ?? part.id;
    const state = part.state;
    if (!state) return;

    const status = state.status;

    if (status === 'pending') {
      // Task/subagent → start scope
      if (part.toolName === 'task' || part.toolName === 'subagent') {
        const scope = this.subagents.startSubagent(key, {
          toolName: part.toolName,
          title: state.title ?? '',
          input: state.input,
        });
        this.sss.push(new ToolInvocationSSP({
          partId: part.id,
          toolName: part.toolName,
          callId: key,
          state,
          subAgentInvocationId: scope.subAgentInvocationId,
        }));
      } else {
        this.sss.push(new ToolInvocationSSP({
          partId: part.id,
          toolName: part.toolName,
          callId: key,
          state,
        }));
      }
    } else {
      // Update existing tool
      this.sss.update(key, { state });

      // Task/subagent completion
      if ((part.toolName === 'task' || part.toolName === 'subagent') &&
          (status === 'completed' || status === 'error')) {
        this.hadSubagentTasks = true;
        const scope = this.subagents.getScope(key);
        if (scope) {
          this.subagents.completeSubagent(key, state.output);
        }
      }

      // Write/edit completion → complete ExternalEditSSP
      if ((status === 'completed' || status === 'error') && this.isWriteEditTool(part.toolName)) {
        this.sss.update(key, { status: 'completed' });
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Permission → ExternalEditSSP with callbacks
  // ════════════════════════════════════════════════════════════════════════

  private handlePermissionAsked(event: AcpPermissionRequestEvent): void {
    const callId = event.tool?.callId;
    const filepath = event.metadata?.filepath as string | undefined;

    if (!callId || !filepath) {
      // Non-file permission: auto-reply directly
      this.backend.permissions.reply(event.sessionId, event.permissionId, 'once', this.directory);
      return;
    }

    const uri = createExternalEditUri(filepath, this.directory);

    this.sss.push(new ExternalEditSSP(
      {
        toolCallId: callId,
        editId: '',
        status: 'pending',
        uri: filepath,
        uris: [uri],
      },
      {
        onBaselineCaptured: () => {
          // Baseline captured → auto-reply permission
          this.backend.permissions.reply(
            event.sessionId,
            event.permissionId,
            'once',
            this.directory,
          );
        },
        onSnapshot: (snapshot) => {
          this.sss.serializeSnapshot(snapshot);
        },
      },
    ));
  }

  // ════════════════════════════════════════════════════════════════════════
  // Question → QuestionSSP with callbacks
  // ════════════════════════════════════════════════════════════════════════

  private handleQuestionAsked(event: AcpQuestionRequestEvent): void {
    const questions = event.questions;

    this.sss.push(new QuestionSSP(
      {
        questionId: event.questionId,
        questions: questions as unknown[],
        status: 'asked',
      },
      {
        onResult: (vscodeRawResult) => {
          const answers = this.mapQuestionAnswers(vscodeRawResult, questions);
          this.backend.questions.reply(
            event.sessionId,
            event.questionId,
            answers,
            this.directory,
          );
          this.sss.update(event.questionId, { status: 'replied' });
        },
        onSkip: () => {
          this.backend.questions.reject(
            event.sessionId,
            event.questionId,
            this.directory,
          );
          this.sss.update(event.questionId, { status: 'skipped' });
        },
      },
    ));
  }

  /** Map VS Code questionCarousel result → OpenCode string[][] format */
  private mapQuestionAnswers(
    vscodeRaw: unknown,
    questions: AcpQuestionInfo[],
  ): string[][] {
    const result = vscodeRaw as Record<string, unknown> | undefined;
    if (!result) return questions.map(() => []);

    return questions.map((_, i) => {
      const key = `q_${i}`;
      const answer = result[key];
      if (answer === undefined || answer === null) return [];

      if (typeof answer === 'string') return [answer];

      if (typeof answer === 'object' && answer !== null) {
        const obj = answer as Record<string, unknown>;
        if ('selectedValue' in obj) {
          if (obj.freeformValue && typeof obj.freeformValue === 'string') return [obj.freeformValue];
          const val = obj.selectedValue;
          return val !== undefined && val !== null ? [String(val)] : [];
        }
        if ('selectedValues' in obj && Array.isArray(obj.selectedValues)) {
          const selected = (obj.selectedValues as unknown[])
            .map(v => v != null ? String(v) : '')
            .filter(v => v !== '');
          if (obj.freeformValue && typeof obj.freeformValue === 'string') selected.push(obj.freeformValue);
          return selected;
        }
      }
      return [];
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // Session lifecycle events → writeMeta
  // ════════════════════════════════════════════════════════════════════════

  private handleSessionUpdated(event: AcpEvent): void {
    const e = event as { title?: string };
    if (e.title) {
      this.sessionTitle = e.title;
      this.sss.writeMeta({ title: e.title, titleSource: 'backend' });
    }
  }

  private handleSessionDiff(event: AcpEvent): void {
    const e = event as { diffs?: unknown[] };
    if (e.diffs) {
      this.sss.writeMeta({
        changeSummary: { files: e.diffs.length },
      });
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Session idle + deferred idle (wait for subagents)
  // ════════════════════════════════════════════════════════════════════════

  private handleSessionIdle(): void {
    this.sss.writeMeta({ status: 'completed' });

    if (this.subagents.hasBusyDescendant()) {
      this.deferredIdle = true;
      this.startDeferredIdleTimer();
      this.logTag('idle', 'deferred — waiting for subagent sessions to complete');
      return;
    }
    // No busy subagents — clean up and let loop end
    this.subagents.clear();
  }

  private startDeferredIdleTimer(): void {
    this.clearDeferredIdleTimer();
    this.deferredIdleTimer = setTimeout(() => {
      this.logTag('idle', `deferred idle timeout (${OpenCodeBridge.DEFERRED_IDLE_TIMEOUT_MS / 1000}s) — stopping`);
      this.deferredIdle = false;
      this.subagents.clear();
    }, OpenCodeBridge.DEFERRED_IDLE_TIMEOUT_MS);
  }

  private clearDeferredIdleTimer(): void {
    if (this.deferredIdleTimer) {
      clearTimeout(this.deferredIdleTimer);
      this.deferredIdleTimer = null;
    }
  }

  /** Check if deferred idle can be resolved (all subagents done) */
  private checkDeferredIdleResolution(): boolean {
    if (!this.deferredIdle) return false;
    if (!this.subagents.hasBusyDescendant()) {
      this.deferredIdle = false;
      this.clearDeferredIdleTimer();
      // Clean up completed scopes
      for (const [callId, s] of this.subagents['scopes'] as Map<string, SubagentScope>) {
        if (s.completed) this.subagents.removeSubagent(callId);
      }
      return true;
    }
    // Reset safety timer on any activity
    this.startDeferredIdleTimer();
    return false;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Child session event routing → subsession
  // ════════════════════════════════════════════════════════════════════════

  private handleChildSessionEvent(event: AcpEvent, eventSessionId: string): void {
    // Find owning scope
    let scope = this.findScopeForSession(eventSessionId);

    // Lazy bind: first scope without childSessionId gets this session
    if (!scope) {
      scope = this.subagents['scopes'] &&
        [...(this.subagents['scopes'] as Map<string, SubagentScope>).values()]
          .find(s => !s.childSessionId);
      if (scope) {
        scope.childSessionId = eventSessionId;
        this.logTag('subagent', `lazy-bound childSessionId=${eventSessionId} to callID=${scope.callId}`);
      }
    }

    if (!scope) {
      this.logTag('subagent', `no matching scope for sessionID=${eventSessionId}`);
      return;
    }

    // Handle idle from child
    if (event.type === 'session.idle') {
      scope.descendantSessionIds.add(eventSessionId);
      if (scope.childSessionId === eventSessionId && !scope.childIdle) {
        scope.childIdle = true;
        scope.timeEnd = Date.now();
        // Update parent task tool card as completed
        this.sss.update(scope.callId, {
          state: { status: 'completed', output: scope.output ?? '' },
        });
      }
      this.checkDeferredIdleResolution();
      return;
    }

    // Handle tool events from child → route to subsession
    if (event.type === 'part.updated') {
      const part = (event as { part?: { type?: string } }).part;
      if (part?.type === 'tool') {
        const toolPart = (event as { part: AcpToolPart }).part;
        const childCallId = toolPart.callId ?? toolPart.id;
        const childStatus = toolPart.state?.status ?? 'running';

        const sub = this.sss.subsession(scope.subAgentInvocationId!);

        if (childStatus === 'pending') {
          sub.push(new ToolInvocationSSP({
            partId: `subagent-child-${childCallId}`,
            toolName: toolPart.toolName,
            callId: childCallId,
            state: toolPart.state!,
            subAgentInvocationId: scope.subAgentInvocationId,
          }));
        } else {
          sub.update(childCallId, { state: toolPart.state });

          if (childStatus === 'completed' || childStatus === 'error') {
            // Record for progress
            this.subagents.recordChildToolCall(scope.callId, {
              name: toolPart.toolName,
              title: toolPart.state?.title,
              status: childStatus,
            });

            // Update parent card progress
            this.sss.update(scope.callId, {
              state: { title: formatSubagentProgress(scope) },
            });
          }
        }
        return;
      }

      // Capture child text for subagent output
      if (part?.type === 'text') {
        const text = (event as { part?: { text?: string } }).part?.text;
        if (text && text.trim()) scope.lastText = text;
      }
    }
  }

  private findScopeForSession(sessionId: string): SubagentScope | undefined {
    const scopes = this.subagents['scopes'] as Map<string, SubagentScope> | undefined;
    if (!scopes) return undefined;
    for (const scope of scopes.values()) {
      if (scope.childSessionId === sessionId) return scope;
      if (scope.descendantSessionIds.has(sessionId)) return scope;
    }
    return undefined;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Utility
  // ════════════════════════════════════════════════════════════════════════

  private isWriteEditTool(toolName: string): boolean {
    return toolName === 'write' || toolName === 'edit';
  }

  getUserMessageId(): string | null { return this.userMessageId; }
  getSessionTitle(): string | null { return this.sessionTitle ?? null; }
  getHadSubagentTasks(): boolean { return this.hadSubagentTasks; }
}
