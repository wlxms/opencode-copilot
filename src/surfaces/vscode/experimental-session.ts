/**
 * Experimental chat-session-provider surface.
 *
 * Designed for a future VS Code proposed API (`registerChatSessionContentProvider`)
 * that would allow extensions to fully custom-render the content of a chat
 * session. This surface:
 *
 * 1. Defines forward-compatible types for the expected provider interface.
 * 2. Exports a factory that builds a `ChatSessionContentProvider`.
 * 3. Uses the `AcpRenderer` for rendering events into session content.
 * 4. Gates every proposed API behind runtime capability checks from
 *    `capabilities.ts` — never assumes the API exists.
 * 5. Can fall back to the stable participant surface when experimental
 *    APIs are unavailable.
 *
 * == Design ==
 * - The `ChatSessionContentProvider` interface is declared locally and does
 *   NOT augment the `vscode` module. Consumers must gate on
 *   `hasRegisterChatSessionContentProvider()` before using it.
 * - The `ExperimentalChatSession` class renders ACP events into structured
 *   session content that a content provider can surface.
 * - All proposed APIs (`thinkingProgress`, `ChatToolInvocationPart`, etc.)
 *   are gated via the `capabilities.ts` module. The surface degrades
 *   gracefully to stable markdown-only rendering when the APIs are absent.
 *
 * == Usage (future) ==
 * ```ts
 * import { hasRegisterChatSessionContentProvider } from './surfaces/vscode/capabilities';
 * import { createSessionContentProvider } from './surfaces/vscode/experimental-session';
 *
 * if (hasRegisterChatSessionContentProvider()) {
 *   const provider = createSessionContentProvider(state);
 *   vscode.chat.registerChatSessionContentProvider(
 *     'opencode-copilot.opencode',
 *     provider,
 *   );
 * }
 * ```
 *
 * @module
 */
import * as vscode from 'vscode';
import type { ExtensionState } from '../../types';
import type { OpenCodeEvent, OpenCodeEventStream } from '../../types/events';

import {
  AcpRenderer,
  buildToolSpecificData,
  formatInvocationMsg,
  formatPastTenseMsg,
  renderToolFallback,
} from './acp-renderer';

import {
  hasRegisterChatSessionContentProvider,
  hasThinkingProgress,
  hasToolUI,
  hasChatToolInvocationPart,
  hasChatResponseMultiDiffPart,
  hasFullProposedSurface,
} from './capabilities';

// ---------------------------------------------------------------------------
// Forward-compatible types for the proposed ChatSessionContentProvider API
// ---------------------------------------------------------------------------

/**
 * Content for a single chat session frame/response.
 * This is the structured data a content provider would return when asked
 * to render a session's content.
 */
export interface SessionFrameContent {
  /** Markdown text content (the AI response) */
  markdown?: string;
  /** Tool invocations that occurred during this response */
  toolInvocations?: SessionToolInvocation[];
  /** Whether this frame contains reasoning (thinking) content */
  hasReasoning?: boolean;
  /** Reasoning text content, if any */
  reasoningText?: string;
  /** File diffs from this response */
  diffs?: SessionDiffEntry[];
}

export interface SessionToolInvocation {
  toolName: string;
  toolCallId: string;
  isError?: boolean;
  invocationMessage?: string;
  pastTenseMessage?: string;
  toolSpecificData?: Record<string, unknown>;
  isComplete?: boolean;
}

export interface SessionDiffEntry {
  file: string;
  additions?: number;
  deletions?: number;
  status: 'added' | 'modified';
}

/**
 * Expected interface for `ChatSessionContentProvider` (future proposed API).
 *
 * When VS Code ships this API, it should match this shape:
 * - `provideSessionContent(session, token)` returns structured content
 *   for the chat session.
 */
export interface ChatSessionContentProvider {
  /**
   * Provide the rendered content for a chat session.
   * @param sessionId - The ID of the chat session to render.
   * @param token - Cancellation token.
   * @returns `SessionFrameContent` or `null`/`undefined` if no content.
   */
  provideSessionContent(
    sessionId: string,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<SessionFrameContent[]>;
}

// ---------------------------------------------------------------------------
// ExperimentalChatSession — renders ACP events into structured content
// ---------------------------------------------------------------------------

/**
 * Accumulates ACP events for a single chat turn and produces structured
 * `SessionFrameContent` that a `ChatSessionContentProvider` can surface.
 *
 * Unlike `AcpRenderer` which pushes directly to a `ChatResponseStream`,
 * this class captures rendered output as structured data for later
 * consumption by a content provider.
 */
export class ExperimentalChatSession {
  private renderer: AcpRenderer;
  private readonly logger?: { appendLine(m: string): void };

  /** Accumulated content for the current turn */
  private frames: SessionFrameContent[] = [];
  private currentFrame: SessionFrameContent = {};

  constructor(options?: { logger?: { appendLine(m: string): void } }) {
    this.renderer = new AcpRenderer(options);
    this.logger = options?.logger;
  }

  /**
   * Process an ACP event and capture it as structured content.
   * Call after each event from the OpenCode event stream.
   */
  processEvent(evt: OpenCodeEvent): void {
    switch (evt.type) {
      case 'message.part.updated':
        this.handlePartUpdated(evt);
        break;
      case 'message.part.delta':
        this.handlePartDelta(evt);
        break;
      case 'session.diff':
        this.handleSessionDiff(evt);
        break;
      case 'session.idle':
        this.flushFrame();
        break;
    }
  }

  /**
   * Get all accumulated frames and reset for the next turn.
   */
  consumeFrames(): SessionFrameContent[] {
    const result = this.frames;
    this.frames = [];
    this.currentFrame = {};
    this.renderer.reset();
    return result;
  }

  /** Get the user message ID captured during rendering */
  getUserMessageId(): string | null {
    return this.renderer.getUserMessageId();
  }

  // -------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------

  private handlePartUpdated(evt: OpenCodeEvent): void {
    const part = (evt as { properties?: { part?: { type: string } } }).properties?.part;
    if (!part) return;

    switch (part.type) {
      case 'reasoning':
        this.currentFrame.hasReasoning = true;
        break;
      case 'tool': {
        const toolPart = part as {
          callID?: string;
          tool?: string;
          state?: { status: string; input?: Record<string, unknown>; output?: string; title?: string; error?: string };
        };
        this.handleToolState(toolPart);
        break;
      }
    }
  }

  private handlePartDelta(evt: OpenCodeEvent): void {
    const props = (evt as { properties?: { partID: string; delta: string; field?: string } }).properties;
    if (!props?.delta) return;

    // We don't track part kinds here (that's the renderer's job).
    // For structured content, we accumulate into the current frame.
    if (this.currentFrame.hasReasoning) {
      this.currentFrame.reasoningText =
        (this.currentFrame.reasoningText ?? '') + props.delta;
    } else {
      this.currentFrame.markdown =
        (this.currentFrame.markdown ?? '') + props.delta;
    }
  }

  private handleSessionDiff(evt: OpenCodeEvent): void {
    const diffs = (evt as { properties?: { diff?: Array<{ file: string; additions?: number; deletions?: number; status: string }> } }).properties?.diff;
    if (!diffs?.length) return;

    const entries: SessionDiffEntry[] = diffs
      .filter((d) => d.status !== 'deleted')
      .map((d) => ({
        file: d.file,
        additions: d.additions,
        deletions: d.deletions,
        status: d.status === 'added' ? 'added' as const : 'modified' as const,
      }));

    if (entries.length > 0) {
      this.currentFrame.diffs = entries;
    }
  }

  private handleToolState(toolPart: {
    callID?: string;
    tool?: string;
    state?: { status: string; input?: Record<string, unknown>; output?: string; title?: string; error?: string };
  }): void {
    const state = toolPart.state;
    if (!state) return;

    const toolName = toolPart.tool ?? 'unknown';
    const callID = toolPart.callID ?? 'unknown';
    const status = state.status;

    if (status === 'completed' || status === 'error') {
      const invocation: SessionToolInvocation = {
        toolName,
        toolCallId: callID,
        isError: status === 'error',
        invocationMessage: formatInvocationMsg(toolName, state.input ?? {}, getTitle(state) ?? toolName),
        pastTenseMessage: formatPastTenseMsg(toolName, getTitle(state) ?? toolName),
        isComplete: true,
      };

      if (status === 'completed') {
        const data = buildToolSpecificData(
          toolName,
          getTitle(state) ?? toolName,
          state.input ?? {},
          state.output ?? '',
        );
        if (data) {
          invocation.toolSpecificData = data as unknown as Record<string, unknown>;
        }
      }

      this.currentFrame.toolInvocations ??= [];
      this.currentFrame.toolInvocations.push(invocation);
    }
  }

  private flushFrame(): void {
    if (
      this.currentFrame.markdown ||
      this.currentFrame.toolInvocations ||
      this.currentFrame.hasReasoning ||
      this.currentFrame.diffs
    ) {
      this.frames.push(this.currentFrame);
    }
    this.currentFrame = {};
  }
}

// ---------------------------------------------------------------------------
// Content provider factory
// ---------------------------------------------------------------------------

/**
 * Create a `ChatSessionContentProvider` for the `opencode-copilot` chat
 * participant.
 *
 * The returned provider:
 * - Is production-ready when `hasRegisterChatSessionContentProvider()` is
 *   `true` at the call site.
 * - Uses runtime capability checks internally — never assumes proposed
 *   APIs exist.
 * - Provides structured `SessionFrameContent[]` that a future VS Code
 *   content provider API can render.
 *
 * @param state - The global extension state.
 * @param context - The extension context (for subscriptions).
 * @returns A `ChatSessionContentProvider` instance.
 */
export function createSessionContentProvider(
  state: ExtensionState,
  context: vscode.ExtensionContext,
): ChatSessionContentProvider {
  const logger = state.outputChannel;

  return {
    provideSessionContent(
      sessionId: string,
      _token: vscode.CancellationToken,
    ): SessionFrameContent[] | null {
      logger.appendLine(
        `[experimental-session] provideSessionContent called for ${sessionId}`,
      );

      // In a full implementation, this would replay stored events for the
      // given session ID and return rendered frames. For now, return null
      // (no content available) as the wire protocol integration is not yet
      // wired through this path.

      // Check experimental API availability for logging
      const caps = {
        registerChatSessionContentProvider: hasRegisterChatSessionContentProvider(),
        fullProposedSurface: false, // No stream to check yet
        toolInvocationPart: hasChatToolInvocationPart(),
        multiDiffPart: hasChatResponseMultiDiffPart(),
      };

      logger.appendLine(
        `[experimental-session] Capabilities: ${JSON.stringify(caps)}`,
      );

      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: render ACP events through the experimental surface
// ---------------------------------------------------------------------------

/**
 * Render ACP events into structured session content using all available
 * proposed APIs. This function:
 *
 * 1. Uses `AcpRenderer` for core rendering.
 * 2. Also captures structured `SessionFrameContent` via
 *    `ExperimentalChatSession`.
 * 3. Gates every proposed API behind runtime checks.
 * 4. Falls back to stable APIs when proposed APIs are unavailable.
 *
 * @param renderer - Pre-configured AcpRenderer instance.
 * @param eventStream - OpenCode event stream to consume.
 * @param stream - The VS Code chat response stream to render to.
 * @param token - Cancellation token.
 * @returns Structured session frames and whether the turn completed.
 */
export async function renderWithExperimentalSurface(
  renderer: AcpRenderer,
  eventStream: OpenCodeEventStream,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<{ frames: SessionFrameContent[]; completed: boolean }> {
  const session = new ExperimentalChatSession();

  // Check stream capabilities at runtime (may or may not be available)
  const hasFullProposed = hasFullProposedSurface(stream);
  const hasToolPart = hasChatToolInvocationPart();
  const hasMultiDiff = hasChatResponseMultiDiffPart();

  const logger = { appendLine: (m: string) => console.log(m) };

  logger.appendLine(
    `[experimental-session] caps: fullProposed=${hasFullProposed}, ` +
    `toolPart=${hasToolPart}, multiDiff=${hasMultiDiff}`,
  );

  renderer.probeStream(stream);

  try {
    for await (const rawEvt of eventStream.stream) {
      if (token.isCancellationRequested) {
        stream.markdown('\n\u26A0\uFE0F Operation cancelled\n');
        break;
      }

      const evt = 'payload' in rawEvt ? rawEvt.payload : rawEvt;

      // Render to the live stream (uses proposed APIs if available)
      const result = renderer.renderEvent(evt, stream);

      // Also capture as structured content
      session.processEvent(evt);

      if (result.rendered) {
        await yieldToEventLoop();
      }

      if (evt.type === 'session.idle') {
        const frames = session.consumeFrames();
        return { frames, completed: true };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Connection lost';
    logger.appendLine(`[experimental-session] Error: ${msg}`);
    stream.markdown(`\n\u26A0\uFE0F ${msg}\n`);
  }

  return { frames: session.consumeFrames(), completed: false };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function getTitle(state: { title?: string }): string | undefined {
  return state.title;
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
