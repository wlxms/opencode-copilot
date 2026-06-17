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
import type { SessionStreamNode } from '../../acp/streaming/session-stream-node';
import { SubagentManager, formatSubagentProgress, type SubagentScope } from '../../ssp/impl/subagent';
import { AssistantTextSSP } from '../../ssp/impl/assistant-text';
import { ReasoningSSP } from '../../ssp/impl/reasoning';
import { ToolInvocationSSP } from '../../ssp/impl/tool-invocation';
import { ExternalEditSSP } from '../../ssp/impl/external-edit';
import { QuestionSSP } from '../../ssp/impl/question';
import { ChatQuestion, ChatQuestionType } from '../../types/vscode-proposed-additions';
import type { AcpBackend } from '../../acp/backend';
import path from 'node:path';
import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEventSessionId(event: AcpEvent): string | undefined {
  const e = event as unknown as Record<string, unknown>;
  return (e.sessionId as string | undefined) ??
    (e.part as { sessionId?: string } | undefined)?.sessionId;
}

function createExternalEditUri(filePath: string, directory?: string): unknown {
  const resolvedPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(directory ?? '', filePath);
  const rawUri = vscode.Uri.file(resolvedPath);
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

type PartRouteKind = 'text' | 'reasoning' | 'ignored';

interface StreamNodeState {
  userMessageId: string | null;
  assistantStarted: boolean;
  partRoutes: Map<string, PartRouteKind>;
  externalEditCallIds: Set<string>;
  externalEditParts: Map<string, ExternalEditSSP>;
  toolCallIds: Set<string>;
}

export class OpenCodeBridge implements AcpBridge {
  private sss!: SerializableSessionStream;
  private logger: BridgeLogger = { appendLine: () => {} };
  private readonly sessionId: string;

  // Event state
  private userMessageId: string | null = null;
  private partTargets = new Map<string, SessionStreamNode>();
  private nodeStates = new WeakMap<SessionStreamNode, StreamNodeState>();
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
    sessionId: string,
    private readonly directory?: string,
    options?: { sessionId?: string },
  ) {
    this.sessionId = options?.sessionId ?? sessionId;
  }

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
        if (this.handleEvent(event)) break;
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

  private handleEvent(event: AcpEvent): boolean | undefined {
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
      case 'session.idle':       return this.handleSessionIdle();
      case 'session.diff':       this.handleSessionDiff(event); break;
      case 'session.status':     break; // log only
      default:                   break;
    }
    return false;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Append-only: text / reasoning deltas → always push
  // ════════════════════════════════════════════════════════════════════════

  private handlePartDelta(event: AcpPartDeltaEvent): void {
    if (!event.delta) return;
    this.renderDeltaToTarget(event, this.sss);
  }

  private handlePartUpdated(event: AcpPartUpdatedEvent): void {
    this.handlePartUpdatedForTarget(event, this.sss, true);
  }

  private handlePartUpdatedForTarget(
    event: AcpPartUpdatedEvent,
    target: SessionStreamNode,
    captureRootUserMessage: boolean,
  ): void {
    const part = event.part;
    const nodeState = this.getNodeState(target);
    switch (part.type) {
      case 'text': {
        // User echo detection: before assistant output starts, the first text
        // message belongs to the user. Restored or user-echo-less streams may
        // begin directly with assistant text, so do not claim that id then.
        const hasInitialText = (part.text ?? '').length > 0;
        if (!nodeState.assistantStarted && nodeState.userMessageId === null && part.messageId && hasInitialText) {
          nodeState.userMessageId = part.messageId;
          if (captureRootUserMessage) {
            this.userMessageId = part.messageId;
          }
        }
        if (!nodeState.assistantStarted && hasInitialText && part.messageId && part.messageId === nodeState.userMessageId) {
          nodeState.partRoutes.set(part.id, 'ignored');
          this.partTargets.set(part.id, target);
          return; // Skip user echo
        }
        nodeState.assistantStarted = true;
        target.push(new AssistantTextSSP({ partId: part.id, delta: part.text ?? '' }));
        nodeState.partRoutes.set(part.id, 'text');
        this.partTargets.set(part.id, target);
        break;
      }
      case 'reasoning':
        nodeState.assistantStarted = true;
        target.push(new ReasoningSSP({ partId: part.id, delta: part.text ?? '' }));
        nodeState.partRoutes.set(part.id, 'reasoning');
        this.partTargets.set(part.id, target);
        break;
      case 'tool':
        this.handleToolState(part, target);
        break;
      case 'step-start':
        nodeState.assistantStarted = true;
        break;
      case 'step-finish':
        break; // No rendering needed
    }
  }

  private renderDeltaToTarget(event: AcpPartDeltaEvent, fallbackTarget: SessionStreamNode): void {
    const target = this.partTargets.get(event.partId) ?? fallbackTarget;
    const targetState = this.getNodeState(target);
    const kind = targetState.partRoutes.get(event.partId);
    if (kind === 'reasoning') {
      target.push(new ReasoningSSP({ partId: event.partId, delta: event.delta }));
    } else if (kind === 'text') {
      target.push(new AssistantTextSSP({ partId: event.partId, delta: event.delta }));
    }
  }

  private getNodeState(target: SessionStreamNode): StreamNodeState {
    let state = this.nodeStates.get(target);
    if (!state) {
      state = {
        userMessageId: null,
        assistantStarted: false,
        partRoutes: new Map(),
        externalEditCallIds: new Set(),
        externalEditParts: new Map(),
        toolCallIds: new Set(),
      };
      this.nodeStates.set(target, state);
    }
    return state;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Mutable: tool lifecycle → push (pending) / update (running/completed)
  // ════════════════════════════════════════════════════════════════════════

  private handleToolState(part: AcpToolPart, target: SessionStreamNode): void {
    const key = part.callId ?? part.id;
    const state = part.state;
    if (!state) return;

    const status = state.status;
    const targetState = this.getNodeState(target);
    const isExternalEdit = targetState.externalEditCallIds.has(key);
    const eventScope = part.sessionId && part.sessionId !== this.sessionId
      ? this.findScopeForSession(part.sessionId)
      : undefined;
    const fallbackScope = eventScope ?? (part.sessionId ? undefined : this.getActiveSubagentScope());
    if (fallbackScope && !this.subagents.getScope(key) && part.toolName !== 'task' && part.toolName !== 'subagent') {
      this.handleSubagentToolPart(fallbackScope, part);
      return;
    }

    if (isExternalEdit && this.isWriteEditTool(part.toolName)) {
      if (status === 'completed' || status === 'error') {
        this.completeExternalEdit(key, state, target);
      }
      return;
    }

    if (status === 'pending') {
      targetState.toolCallIds.add(key);
      // Task/subagent → start scope
      if (part.toolName === 'task' || part.toolName === 'subagent') {
        const scope = this.subagents.startSubagent(key, {
          toolName: part.toolName,
          title: state.title ?? '',
          input: state.input,
        });
        target.push(new ToolInvocationSSP({
          partId: part.id,
          toolName: part.toolName,
          callId: key,
          state,
          subAgentInvocationId: scope.subAgentInvocationId,
        }));
      } else {
        target.push(new ToolInvocationSSP({
          partId: part.id,
          toolName: part.toolName,
          callId: key,
          state,
        }));
      }
    } else {
      if (!targetState.toolCallIds.has(key)) {
        targetState.toolCallIds.add(key);
        const scope = (part.toolName === 'task' || part.toolName === 'subagent')
          ? this.subagents.startSubagent(key, {
              toolName: part.toolName,
              title: state.title ?? '',
              input: state.input,
            })
          : undefined;
        target.push(new ToolInvocationSSP({
          partId: part.id,
          toolName: part.toolName,
          callId: key,
          state,
          subAgentInvocationId: scope?.subAgentInvocationId,
        }));
      } else {
        target.update(key, { state });
      }

      // Task/subagent completion
      if ((part.toolName === 'task' || part.toolName === 'subagent') &&
          (status === 'completed' || status === 'error')) {
        this.hadSubagentTasks = true;
        const scope = this.subagents.getScope(key);
        if (scope) {
          const childSessionId = this.getToolSessionId(state);
          if (childSessionId) {
            this.subagents.setChildSession(key, childSessionId);
            this.recordAncestorDescendantSessions(scope, childSessionId);
          }
          this.subagents.completeSubagent(key, state.output);
        }
      }

      // Write/edit completion → complete ExternalEditSSP
      if ((status === 'completed' || status === 'error') && this.isWriteEditTool(part.toolName)) {
        if (targetState.externalEditCallIds.has(key)) {
          this.completeExternalEdit(key, state, target);
        }
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Permission → ExternalEditSSP with callbacks
  // ════════════════════════════════════════════════════════════════════════

  private completeExternalEdit(
    callId: string,
    state: AcpToolState,
    target: SessionStreamNode,
  ): void {
    const targetState = this.getNodeState(target);
    const externalEdit = targetState.externalEditParts.get(callId);
    if (externalEdit) {
      target.update(externalEdit.id, { status: 'completed' });
    }
    if (targetState.toolCallIds.has(callId) && target.has(callId)) {
      target.update(callId, {
        state: {
          ...state,
          metadata: { ...state.metadata, externalEdit: true, presentation: 'hidden' },
        },
      });
    }
  }

  private handlePermissionAsked(event: AcpPermissionRequestEvent): void {
    this.startExternalEdit(event, this.sss);
  }

  private startExternalEdit(event: AcpPermissionRequestEvent, target: SessionStreamNode): void {
    const callId = event.tool?.callId;
    const filepath = event.metadata?.filepath as string | undefined;

    if (!callId || !filepath) {
      // Non-file permission: auto-reply directly
      this.backend.permissions.reply(event.sessionId, event.permissionId, 'once', this.directory);
      return;
    }

    const uri = createExternalEditUri(filepath, this.directory);
    const targetState = this.getNodeState(target);
    targetState.externalEditCallIds.add(callId);

    const externalEdit = new ExternalEditSSP(
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
    );
    targetState.externalEditParts.set(callId, externalEdit);
    target.push(externalEdit);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Question → QuestionSSP with callbacks
  // ════════════════════════════════════════════════════════════════════════

  private handleQuestionAsked(event: AcpQuestionRequestEvent): void {
    this.startQuestion(event, this.sss);
  }

  private startQuestion(event: AcpQuestionRequestEvent, target: SessionStreamNode): void {
    const questions = event.questions;

    target.push(new QuestionSSP(
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
          target.update(event.questionId, { status: 'replied' });
        },
        onSkip: () => {
          this.backend.questions.reject(
            event.sessionId,
            event.questionId,
            this.directory,
          );
          target.update(event.questionId, { status: 'skipped' });
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

  private handleSessionIdle(): boolean {
    this.sss.writeMeta({ status: 'completed' });

    if (this.subagents.hasBusyDescendant()) {
      this.deferredIdle = true;
      this.startDeferredIdleTimer();
      this.logTag('idle', 'deferred — waiting for subagent sessions to complete');
      return false;
    }
    // No busy subagents — clean up and let loop end
    this.subagents.clear();
    return true;
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

    const target = this.getSubsessionStream(scope.subAgentInvocationId!);

    if (event.type === 'permission.asked') {
      this.startExternalEdit(event, target);
      return;
    }

    if (event.type === 'question.asked') {
      this.startQuestion(event, target);
      return;
    }

    if (event.type === 'session.updated') {
      const e = event as { title?: string };
      if (e.title) {
        target.writeMeta({ title: e.title, titleSource: 'backend' });
      }
      return;
    }

    if (event.type === 'session.diff') {
      const e = event as { diffs?: unknown[] };
      if (e.diffs) {
        target.writeMeta({ changeSummary: { files: e.diffs.length } });
      }
      return;
    }

    if (event.type === 'session.status') {
      const e = event as { status?: unknown };
      target.writeMeta({ status: e.status });
      return;
    }

    // Handle idle from child
    if (event.type === 'session.idle') {
      scope.descendantSessionIds.add(eventSessionId);
      this.recordAncestorDescendantSessions(scope, eventSessionId);
      if (scope.childSessionId === eventSessionId && !scope.childIdle) {
        scope.childIdle = true;
        scope.timeEnd = Date.now();
        this.updateScopeTool(scope, { status: 'completed', output: scope.output ?? '' });
      }
      this.checkDeferredIdleResolution();
      return;
    }

    // Handle tool events from child → route to subsession
    if (event.type === 'part.updated') {
      const part = (event as { part?: { type?: string } }).part;
      if (part?.type === 'tool') {
        const toolPart = (event as { part: AcpToolPart }).part;
        this.handleSubagentToolPart(scope, toolPart);
        return;
      }

      // Capture child text for subagent output
      if (part?.type === 'text') {
        const text = (event as { part?: { text?: string } }).part?.text;
        if (text && text.trim()) scope.lastText = text;
      }
      this.handlePartUpdatedForTarget(event as AcpPartUpdatedEvent, target, false);
      return;
    }

    if (event.type === 'part.delta') {
      this.renderDeltaToTarget(event as AcpPartDeltaEvent, target);
      return;
    }
  }

  private findScopeForSession(sessionId: string): SubagentScope | undefined {
    const scopes = this.subagents['scopes'] as Map<string, SubagentScope> | undefined;
    if (!scopes) return undefined;
    for (const scope of scopes.values()) {
      if (scope.childSessionId === sessionId) return scope;
    }
    for (const scope of scopes.values()) {
      if (scope.descendantSessionIds.has(sessionId)) return scope;
    }
    return undefined;
  }

  private getActiveSubagentScope(): SubagentScope | undefined {
    const scopes = this.subagents['scopes'] as Map<string, SubagentScope> | undefined;
    if (!scopes) return undefined;
    return [...scopes.values()]
      .filter(scope => !scope.childIdle && !scope.completed)
      .sort((a, b) => this.getScopeDepth(b) - this.getScopeDepth(a))[0];
  }

  private getScopeDepth(scope: SubagentScope): number {
    const scopes = this.subagents['scopes'] as Map<string, SubagentScope> | undefined;
    let depth = 0;
    let current = scope;
    while (current.parentSubAgentInvocationId) {
      const parent = this.findScopeBySubAgentInvocationId(current.parentSubAgentInvocationId, scopes);
      if (!parent) break;
      depth += 1;
      current = parent;
    }
    return depth;
  }

  private handleSubagentToolPart(scope: SubagentScope, toolPart: AcpToolPart): void {
    const childCallId = toolPart.callId ?? toolPart.id;
    const childStatus = toolPart.state?.status ?? 'running';
    const sub = this.getSubsessionStream(scope.subAgentInvocationId!);
    const subState = this.getNodeState(sub);
    const isExternalEdit = subState.externalEditCallIds.has(childCallId) && this.isWriteEditTool(toolPart.toolName);
    if (isExternalEdit) {
      if (childStatus === 'completed' || childStatus === 'error') {
        this.completeExternalEdit(childCallId, toolPart.state!, sub);
        this.subagents.recordChildToolCall(scope.callId, {
          name: toolPart.toolName,
          title: toolPart.state?.title,
          status: childStatus,
        });
        this.updateScopeTool(scope, { title: formatSubagentProgress(scope) });
      }
      return;
    }
    let nestedScope: SubagentScope | undefined;
    if (toolPart.toolName === 'task' || toolPart.toolName === 'subagent') {
      nestedScope = this.subagents.getScope(childCallId);
      if (!nestedScope) {
        nestedScope = this.subagents.startSubagent(
          childCallId,
          {
            toolName: toolPart.toolName,
            title: toolPart.state?.title ?? '',
            input: toolPart.state?.input ?? {},
          },
          scope.subAgentInvocationId,
        );
      }
      const childSessionId = this.getToolSessionId(toolPart.state);
      if (childSessionId) {
        this.subagents.setChildSession(childCallId, childSessionId);
        this.recordAncestorDescendantSessions(nestedScope, childSessionId);
      }
    }
    const payload = {
      partId: `subagent-child-${childCallId}`,
      toolName: toolPart.toolName,
      callId: childCallId,
      state: toolPart.state!,
      subAgentInvocationId: nestedScope?.subAgentInvocationId ?? scope.subAgentInvocationId,
    };

    if (childStatus === 'pending' || !sub.has(childCallId)) {
      subState.toolCallIds.add(childCallId);
      sub.push(new ToolInvocationSSP(payload));
    } else {
      sub.update(childCallId, { state: toolPart.state });
    }

    if (childStatus === 'completed' || childStatus === 'error') {
      if (subState.externalEditCallIds.has(childCallId) && this.isWriteEditTool(toolPart.toolName)) {
        this.completeExternalEdit(childCallId, toolPart.state!, sub);
      }
      if (nestedScope) {
        this.subagents.completeSubagent(childCallId, toolPart.state?.output);
      }
      this.subagents.recordChildToolCall(scope.callId, {
        name: toolPart.toolName,
        title: toolPart.state?.title,
        status: childStatus,
      });
      this.updateScopeTool(scope, { title: formatSubagentProgress(scope) });
    }
  }

  private updateScopeTool(scope: SubagentScope, state: Partial<AcpToolState>): void {
    const target = scope.parentSubAgentInvocationId
      ? this.getSubsessionStream(scope.parentSubAgentInvocationId)
      : this.sss;
    target.update(scope.callId, { state });
  }

  private recordAncestorDescendantSessions(scope: SubagentScope | undefined, sessionId: string): void {
    const scopes = this.subagents['scopes'] as Map<string, SubagentScope> | undefined;
    let current = scope;
    while (current?.parentSubAgentInvocationId) {
      const parent = this.findScopeBySubAgentInvocationId(current.parentSubAgentInvocationId, scopes);
      if (!parent) return;
      this.subagents.addDescendantSession(parent.callId, sessionId);
      current = parent;
    }
  }

  private getSubsessionStream(subAgentInvocationId: string): SubsessionStream {
    const scopes = this.subagents['scopes'] as Map<string, SubagentScope> | undefined;
    const scope = this.findScopeBySubAgentInvocationId(subAgentInvocationId, scopes);
    const chain: string[] = [];
    let current: SubagentScope | undefined = scope;

    while (current) {
      if (current.subAgentInvocationId) {
        chain.unshift(current.subAgentInvocationId);
      }
      current = current.parentSubAgentInvocationId
        ? this.findScopeBySubAgentInvocationId(current.parentSubAgentInvocationId, scopes)
        : undefined;
    }

    const ids = chain.length > 0 ? chain : [subAgentInvocationId];
    let sub = this.sss.subsession(ids[0]);
    for (const id of ids.slice(1)) {
      sub = sub.subsession(id);
    }
    return sub;
  }

  private findScopeBySubAgentInvocationId(
    subAgentInvocationId: string,
    scopes = this.subagents['scopes'] as Map<string, SubagentScope> | undefined,
  ): SubagentScope | undefined {
    if (!scopes) return undefined;
    return [...scopes.values()].find(scope => scope.subAgentInvocationId === subAgentInvocationId);
  }

  private getToolSessionId(state: AcpToolState | undefined): string | undefined {
    const raw = state?.metadata?.sessionId ?? state?.metadata?.sessionID;
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
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
