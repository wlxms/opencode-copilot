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
  pendingDeltas: Map<string, AcpPartDeltaEvent[]>;
  deltaText: Map<string, string>;
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
  private pendingChildEvents = new Map<string, AcpEvent[]>();
  private childSessionHints = new Map<string, string>();

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
      case 'session.created':    this.handleSessionCreated(event); break;
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
        // Skip if already routed — part.updated fires again at completion
        // with the full accumulated text; deltas already rendered the content.
        if (nodeState.partRoutes.has(part.id)) {
          this.partTargets.set(part.id, target);
          return;
        }
        // User echo detection: before assistant output starts, the first text
        // message belongs to the user. Restored or user-echo-less streams may
        // begin directly with assistant text, so do not claim that id then.
        const hasInitialText = (part.text ?? '').length > 0;
        const hasBufferedDeltas = (nodeState.pendingDeltas.get(part.id)?.length ?? 0) > 0;
        if (!nodeState.assistantStarted && nodeState.userMessageId === null && part.messageId && hasInitialText && !hasBufferedDeltas) {
          nodeState.userMessageId = part.messageId;
          if (captureRootUserMessage) {
            this.userMessageId = part.messageId;
          }
        }
        if (!nodeState.assistantStarted && hasInitialText && !hasBufferedDeltas && part.messageId && part.messageId === nodeState.userMessageId) {
          nodeState.partRoutes.set(part.id, 'ignored');
          this.partTargets.set(part.id, target);
          return; // Skip user echo
        }
        nodeState.assistantStarted = true;
        nodeState.partRoutes.set(part.id, 'text');
        this.partTargets.set(part.id, target);
        const hadBufferedDelta = this.flushPendingDeltas(part.id, target);
        if (!hadBufferedDelta) {
          target.push(new AssistantTextSSP({
            partId: part.id,
            delta: part.text ?? '',
            messageId: part.messageId,
            sessionId: event.sessionId ?? part.sessionId,
          }));
          this.appendDeltaText(target, part.id, part.text ?? '');
        }
        break;
      }
      case 'reasoning':
        // Skip if already routed — same dedup as text (see above)
        if (nodeState.partRoutes.has(part.id)) {
          this.partTargets.set(part.id, target);
          return;
        }
        nodeState.assistantStarted = true;
        nodeState.partRoutes.set(part.id, 'reasoning');
        this.partTargets.set(part.id, target);
        const hadBufferedDelta = this.flushPendingDeltas(part.id, target);
        if (!hadBufferedDelta) {
          target.push(new ReasoningSSP({
            partId: part.id,
            delta: part.text ?? '',
            messageId: part.messageId,
            sessionId: event.sessionId ?? part.sessionId,
          }));
          this.appendDeltaText(target, part.id, part.text ?? '');
        }
        break;
      case 'tool':
        this.handleToolState(part, target, event.sessionId);
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
      target.push(new ReasoningSSP({ partId: event.partId, delta: event.delta, sessionId: event.sessionId }));
      this.appendDeltaText(target, event.partId, event.delta);
    } else if (kind === 'text') {
      target.push(new AssistantTextSSP({ partId: event.partId, delta: event.delta, sessionId: event.sessionId }));
      this.appendDeltaText(target, event.partId, event.delta);
    } else if (event.sessionId) {
      const pending = targetState.pendingDeltas.get(event.partId) ?? [];
      pending.push(event);
      targetState.pendingDeltas.set(event.partId, pending);
    }
  }

  private flushPendingDeltas(partId: string, target: SessionStreamNode): boolean {
    const targetState = this.getNodeState(target);
    const pending = targetState.pendingDeltas.get(partId);
    if (!pending || pending.length === 0) return false;
    targetState.pendingDeltas.delete(partId);
    for (const event of pending) {
      this.renderDeltaToTarget(event, target);
    }
    return true;
  }

  private appendDeltaText(target: SessionStreamNode, partId: string, delta: string): void {
    if (!delta) return;
    const targetState = this.getNodeState(target);
    targetState.deltaText.set(partId, (targetState.deltaText.get(partId) ?? '') + delta);
  }

  private getDeltaText(target: SessionStreamNode, partId: string): string | undefined {
    return this.getNodeState(target).deltaText.get(partId);
  }

  private isAssistantTextPart(target: SessionStreamNode, partId: string | undefined): boolean {
    if (!partId) return false;
    return this.getNodeState(target).partRoutes.get(partId) === 'text';
  }

  private getNodeState(target: SessionStreamNode): StreamNodeState {
    let state = this.nodeStates.get(target);
    if (!state) {
      state = {
        userMessageId: null,
        assistantStarted: false,
        partRoutes: new Map(),
        pendingDeltas: new Map(),
        deltaText: new Map(),
        toolCallIds: new Set(),
      };
      this.nodeStates.set(target, state);
    }
    return state;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Mutable: tool lifecycle → push (pending) / update (running/completed)
  // ════════════════════════════════════════════════════════════════════════

  private handleToolState(
    part: AcpToolPart,
    target: SessionStreamNode,
    eventSessionId = part.sessionId,
  ): void {
    const key = part.callId ?? part.id;
    const state = part.state;
    if (!state) return;

    const status = state.status;
    const targetState = this.getNodeState(target);
    const sessionId = eventSessionId ?? part.sessionId;
    const eventScope = sessionId && sessionId !== this.sessionId
      ? this.findScopeForSession(sessionId)
      : undefined;
    const fallbackScope = eventScope ?? (sessionId ? undefined : this.getActiveSubagentScope());
    if (fallbackScope && !this.subagents.getScope(key) && part.toolName !== 'task' && part.toolName !== 'subagent') {
      this.handleSubagentToolPart(fallbackScope, part, sessionId);
      return;
    }

    // Write/edit tools: defer SSP creation until permission.asked creates ExternalEditSSP.
    // If permission never comes (auto-approve), create ToolInvocationSSP at completion.
    if (this.isWriteEditTool(part.toolName)) {
      if (target.has(key)) {
        // ExternalEditSSP exists → external edit path
        if (status === 'completed' || status === 'error') {
          this.completeExternalEdit(key, target);
        }
        return;
      }
      // No ExternalEditSSP yet — keep deferring at pending/running
      if (status === 'pending' || status === 'running') return;
      // completed/error without permission → fall through to normal tool handling
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
          messageId: part.messageId,
          sessionId,
        }));
      } else {
        target.push(new ToolInvocationSSP({
          partId: part.id,
          toolName: part.toolName,
          callId: key,
          state,
          messageId: part.messageId,
          sessionId,
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
          messageId: part.messageId,
          sessionId,
        }));
      } else if (part.toolName === 'task' || part.toolName === 'subagent') {
        const renderState = status === 'completed' || status === 'error'
          ? { ...state, status: 'running' as const }
          : state;
        target.update(key, { state: renderState });
      } else {
        target.update(key, { state });
      }

      // Task/subagent completion
      if (part.toolName === 'task' || part.toolName === 'subagent') {
        const scope = this.subagents.getScope(key);
        if (scope) {
          const childSessionId = this.getToolSessionId(state);
          if (childSessionId) {
            this.bindScopeToChildSession(scope, childSessionId);
          }

          if (status === 'completed' || status === 'error') {
            this.hadSubagentTasks = true;
            this.subagents.completeSubagent(key, state.output);
            if (scope.childIdle || status === 'error') {
              this.finalizeScopeTool(scope);
              this.checkDeferredIdleResolution();
            }
          }
        }
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Permission → ExternalEditSSP with callbacks
  // ════════════════════════════════════════════════════════════════════════

  private completeExternalEdit(callId: string, target: SessionStreamNode): void {
    target.update(callId, { status: 'completed' });
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

    target.push(new ExternalEditSSP(
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

  private handleSessionCreated(event: AcpEvent): void {
    const e = event as { sessionId?: string; parentId?: string; title?: string };
    if (e.sessionId && e.parentId) {
      this.childSessionHints.set(e.sessionId, e.parentId);
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
      for (const scope of this.subagents.listScopes()) {
        if (scope.completed) this.subagents.removeSubagent(scope.callId);
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
    if (event.type === 'session.created' || event.type === 'session.updated') {
      const created = event as { parentId?: string };
      if (created.parentId) {
        this.childSessionHints.set(eventSessionId, created.parentId);
      }
    }

    // Find owning scope
    let scope = this.findScopeForSession(eventSessionId);

    if (!scope) {
      scope = this.findBindableScopeForChildSession(eventSessionId);
      if (scope) {
        this.bindScopeToChildSession(scope, eventSessionId);
        scope = this.findScopeForSession(eventSessionId) ?? scope;
      }
    }

    if (!scope) {
      this.bufferChildEvent(eventSessionId, event);
      this.logTag('subagent', `buffered child event type=${event.type} for sessionID=${eventSessionId}`);
      return;
    }

    if (event.type === 'session.created') {
      const e = event as { title?: string };
      if (e.title) {
        const target = this.getSubsessionStream(scope.subAgentInvocationId!);
        target.writeMeta({ title: e.title, titleSource: 'backend' });
      }
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
        if (scope.completed) {
          this.finalizeScopeTool(scope);
        }
      }
      this.checkDeferredIdleResolution();
      return;
    }

    // Handle tool events from child → route to subsession
    if (event.type === 'part.updated') {
      const part = (event as { part?: { type?: string } }).part;
      if (part?.type === 'tool') {
        const toolPart = (event as { part: AcpToolPart }).part;
        this.handleSubagentToolPart(scope, toolPart, eventSessionId);
        return;
      }

      this.handlePartUpdatedForTarget(event as AcpPartUpdatedEvent, target, false);
      // Capture child text for the parent subagent card result.
      if (part?.type === 'text') {
        const textPart = (event as { part?: { id?: string; text?: string } }).part;
        if (this.isAssistantTextPart(target, textPart?.id)) {
          const streamedText = textPart?.id ? this.getDeltaText(target, textPart.id) : undefined;
          const text = streamedText ?? textPart?.text;
          if (text && text.trim()) scope.lastText = text;
        }
      }
      return;
    }

    if (event.type === 'part.delta') {
      const deltaEvent = event as AcpPartDeltaEvent;
      this.renderDeltaToTarget(deltaEvent, target);
      const text = this.isAssistantTextPart(target, deltaEvent.partId)
        ? this.getDeltaText(target, deltaEvent.partId)
        : undefined;
      if (text && text.trim()) {
        scope.lastText = text;
      }
      return;
    }
  }

  private findScopeForSession(sessionId: string): SubagentScope | undefined {
    return this.subagents.findScopeForSession(sessionId);
  }

  private findBindableScopeForChildSession(sessionId: string): SubagentScope | undefined {
    const parentId = this.childSessionHints.get(sessionId);
    const unbound = this.subagents.listScopes().filter(scope => !scope.childSessionId);
    if (unbound.length === 0) return undefined;

    let candidates = unbound;
    if (parentId) {
      const parentScope = this.findScopeForSession(parentId);
      candidates = parentScope?.subAgentInvocationId
        ? unbound.filter(scope => scope.parentSubAgentInvocationId === parentScope.subAgentInvocationId)
        : parentId === this.sessionId
          ? unbound.filter(scope => !scope.parentSubAgentInvocationId)
          : [];
    }

    return candidates.length === 1 ? candidates[0] : undefined;
  }

  private bindScopeToChildSession(
    scope: SubagentScope,
    childSessionId: string,
    drainPending = true,
  ): void {
    if (scope.childSessionId === childSessionId) return;
    if (scope.childSessionId && scope.childSessionId !== childSessionId) {
      this.logTag('subagent', `scope callID=${scope.callId} already bound to childSessionId=${scope.childSessionId}, ignoring ${childSessionId}`);
      return;
    }

    this.subagents.setChildSession(scope.callId, childSessionId);
    this.recordAncestorDescendantSessions(scope, childSessionId);
    this.logTag('subagent', `bound childSessionId=${childSessionId} to callID=${scope.callId}`);

    if (drainPending) {
      this.drainPendingChildEvents(childSessionId);
    }
  }

  private bufferChildEvent(sessionId: string, event: AcpEvent): void {
    const existing = this.pendingChildEvents.get(sessionId) ?? [];
    existing.push(event);
    this.pendingChildEvents.set(sessionId, existing);
  }

  private drainPendingChildEvents(sessionId: string): void {
    const pending = this.pendingChildEvents.get(sessionId);
    if (!pending || pending.length === 0) return;
    this.pendingChildEvents.delete(sessionId);
    for (const event of pending) {
      this.handleChildSessionEvent(event, sessionId);
    }
  }

  private getActiveSubagentScope(): SubagentScope | undefined {
    return this.subagents.listScopes()
      .filter(scope => !scope.childIdle && !scope.completed)
      .sort((a, b) => this.getScopeDepth(b) - this.getScopeDepth(a))[0];
  }

  private getScopeDepth(scope: SubagentScope): number {
    let depth = 0;
    let current = scope;
    while (current.parentSubAgentInvocationId) {
      const parent = this.subagents.findScopeBySubAgentInvocationId(current.parentSubAgentInvocationId);
      if (!parent) break;
      depth += 1;
      current = parent;
    }
    return depth;
  }

  private handleSubagentToolPart(
    scope: SubagentScope,
    toolPart: AcpToolPart,
    eventSessionId = toolPart.sessionId,
  ): void {
    const childCallId = toolPart.callId ?? toolPart.id;
    const childStatus = toolPart.state?.status ?? 'running';
    const sub = this.getSubsessionStream(scope.subAgentInvocationId!);
    const subState = this.getNodeState(sub);

    // Write/edit tools: defer until permission.asked creates ExternalEditSSP.
    if (this.isWriteEditTool(toolPart.toolName)) {
      if (sub.has(childCallId)) {
        if (childStatus === 'completed' || childStatus === 'error') {
          this.completeExternalEdit(childCallId, sub);
          this.subagents.recordChildToolCall(scope.callId, {
            name: toolPart.toolName,
            title: toolPart.state?.title,
            status: childStatus,
          });
          this.updateScopeTool(scope, { title: formatSubagentProgress(scope) });
        }
        return;
      }
      // No ExternalEditSSP yet — keep deferring at pending/running
      if (childStatus === 'pending' || childStatus === 'running') return;
      // completed/error without permission → fall through to normal handling
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
        this.bindScopeToChildSession(nestedScope, childSessionId);
      }
    }
    const payload = {
      partId: `subagent-child-${childCallId}`,
      toolName: toolPart.toolName,
      callId: childCallId,
      state: toolPart.state!,
      messageId: toolPart.messageId,
      sessionId: eventSessionId,
      subAgentInvocationId: scope.subAgentInvocationId,
    };

    if (childStatus === 'pending' || !sub.has(childCallId)) {
      subState.toolCallIds.add(childCallId);
      sub.push(new ToolInvocationSSP(payload));
    } else {
      sub.update(childCallId, { state: toolPart.state });
    }

    if (childStatus === 'completed' || childStatus === 'error') {
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

  private finalizeScopeTool(scope: SubagentScope): void {
    const output = scope.lastText?.trim() || scope.output || '';
    this.updateScopeTool(scope, {
      status: 'completed',
      output,
      title: formatSubagentProgress(scope) || scope.toolMeta?.title,
    });
  }

  private recordAncestorDescendantSessions(scope: SubagentScope | undefined, sessionId: string): void {
    let current = scope;
    while (current?.parentSubAgentInvocationId) {
      const parent = this.subagents.findScopeBySubAgentInvocationId(current.parentSubAgentInvocationId);
      if (!parent) return;
      this.subagents.addDescendantSession(parent.callId, sessionId);
      current = parent;
    }
  }

  private getSubsessionStream(subAgentInvocationId: string): SubsessionStream {
    const scope = this.subagents.findScopeBySubAgentInvocationId(subAgentInvocationId);
    const chain: string[] = [];
    let current: SubagentScope | undefined = scope;

    while (current) {
      if (current.subAgentInvocationId) {
        chain.unshift(current.subAgentInvocationId);
      }
      current = current.parentSubAgentInvocationId
        ? this.subagents.findScopeBySubAgentInvocationId(current.parentSubAgentInvocationId)
        : undefined;
    }

    const ids = chain.length > 0 ? chain : [subAgentInvocationId];
    let sub = this.sss.subsession(ids[0]);
    for (const id of ids.slice(1)) {
      sub = sub.subsession(id);
    }
    return sub;
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
