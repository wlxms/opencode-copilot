/**
 * Proposed API types from vscode.proposed.chatParticipantPrivate.d.ts
 * Source: https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.chatParticipantPrivate.d.ts
 *
 * These types augment the vscode module to add session tracking properties
 * to ChatRequest that are only available when chatParticipantPrivate is
 * enabled in package.json enabledApiProposals.
 */
declare module 'vscode' {
  export interface ChatRequest {
    /**
     * The id of the chat request. Used to identify an interaction with any of the chat surfaces.
     */
    readonly id: string;

    /**
     * The session identifier for this chat request.
     * Same sessionId = same VSCode chat panel = should reuse OpenCode session.
     * Different sessionId = new VSCode chat = should create new OpenCode session.
     */
    readonly sessionId: string;

    /**
     * The resource URI for the chat session this request belongs to.
     */
    readonly sessionResource: Uri;

    /**
     * The attempt number of the request. The first request has attempt number 0.
     */
    readonly attempt: number;
  }
}

/**
 * Proposed API types from vscode.proposed.chatSessionsProvider.d.ts (version 3)
 * Source: https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.chatSessionsProvider.d.ts
 *
 * These types augment the vscode module to add chat session content provider
 * APIs that are only available when chatSessionsProvider is enabled in
 * package.json enabledApiProposals.
 *
 * This API allows extensions to register as a "session target" in VS Code's
 * chat view — appearing alongside Local, Copilot CLI, Cloud, Claude, etc.
 * in the Session Target dropdown.
 */
declare module 'vscode' {

  // ---------------------------------------------------------------------------
  // ChatSessionInputState
  // ---------------------------------------------------------------------------

  /**
   * Represents the input state of a chat session, including selected options.
   */
  export interface ChatSessionInputState {
    sessionResource?: Uri;
    sessionOptions?: ReadonlyArray<{ optionId: string; value: string | ChatSessionProviderOptionItem }>;
  }

  // ---------------------------------------------------------------------------
  // ChatSession
  // ---------------------------------------------------------------------------

  /**
   * Represents a chat session returned by `provideChatSessionContent`.
   *
   * This is the core object that VS Code uses to render the session and route
   * requests. The `requestHandler` property is critical — without it, VS Code
   * falls back to the default Copilot agent.
   */
  export interface ChatSession {
    /**
     * An optional title for the chat session.
     */
    readonly title?: string;

    /**
     * The history of turns in this chat session.
     */
    readonly history: (ChatRequestTurn | ChatResponseTurn)[];

    /**
     * Optional session options (e.g. model selection, agent selection).
     */
    readonly options?: ChatSessionInputState;

    /**
     * Optional callback for proactive session response (e.g. resuming
     * an ongoing interaction when the session becomes active).
     *
     * If not provided, the chat session is assumed to not currently be running.
     */
    readonly activeResponseCallback?: (
      stream: ChatResponseStream,
      token: CancellationToken,
    ) => Thenable<void>;

    /**
     * Handles new request for the session.
     *
     * If not set, then the session will be considered read-only and no
     * requests can be made.
     */
    readonly requestHandler: ChatRequestHandler | undefined;

    /**
     * Handles a request to fork the session.
     */
    readonly forkHandler?: (
      sessionResource: Uri,
      request: ChatRequestTurn | undefined,
      token: CancellationToken,
    ) => Thenable<ChatSessionItem> | ChatSessionItem;
  }

  // ---------------------------------------------------------------------------
  // ChatSessionContentProvider
  // ---------------------------------------------------------------------------

  /**
   * Provides content for chat sessions of a specific type (URI scheme).
   *
   * Extensions implement this interface and register it via
   * `vscode.chat.registerChatSessionContentProvider()` to appear as a
   * session target in VS Code's chat view.
   */
  export interface ChatSessionContentProvider {
    /**
     * Provide the content for a chat session identified by its resource URI.
     *
     * @param resource - The URI of the chat session to provide content for.
     * @param token - Cancellation token.
     * @param context - Additional context for the chat session.
     * @returns The chat session, including its request handler.
     */
    provideChatSessionContent(
      resource: Uri,
      token: CancellationToken,
      context: { readonly inputState: ChatSessionInputState },
    ): Thenable<ChatSession> | ChatSession;

    /**
     * Optional event fired when provider-level options change.
     */
    readonly onDidChangeChatSessionProviderOptions?: Event<void>;

    /**
     * Option groups for this provider (e.g. model picker, agent picker).
     */
    readonly optionGroups?: readonly ChatSessionProviderOptionGroup[];
  }

  // ---------------------------------------------------------------------------
  // ChatSessionProvider options
  // ---------------------------------------------------------------------------

  /**
   * An option item within a provider option group.
   */
  export interface ChatSessionProviderOptionItem {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly detail?: string;
    readonly icon?: ThemeIcon;
    readonly default?: boolean;
  }

  /**
   * A group of options shown in the session provider's picker UI.
   * For example, a model picker, agent picker, or permission mode picker.
   */
  export interface ChatSessionProviderOptionGroup {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly detail?: string;
    readonly items: readonly ChatSessionProviderOptionItem[];
    readonly selected?: ChatSessionProviderOptionItem;
    readonly when?: string;
    readonly icon?: ThemeIcon;
  }

  // ---------------------------------------------------------------------------
  // ChatSessionCapabilities
  // ---------------------------------------------------------------------------

  /**
   * Capabilities that a session content provider declares.
   */
  export interface ChatSessionCapabilities {
    /**
     * Whether this provider supports changing the session type mid-session
     * (e.g. hand-off from local to cloud).
     */
    supportsChangingSessionType?: boolean;
  }

  // ---------------------------------------------------------------------------
  // Chat namespace extension
  // ---------------------------------------------------------------------------

  export namespace chat {
    /**
     * Register a chat session content provider for a given URI scheme.
     *
     * This makes the extension appear as a "session target" in VS Code's
     * chat view, listed alongside Local, Copilot CLI, Cloud, Claude, etc.
     *
     * @param scheme - Unique URI scheme for this provider (e.g. 'opencode').
     *   Must match the `type` declared in the `chatSessions` contribution
     *   in package.json.
     * @param provider - The content provider implementation.
     * @param defaultChatParticipant - The chat participant to use as default
     *   for sessions created through this provider.
     * @param capabilities - Optional capabilities for this provider.
     * @returns A disposable that unregisters the provider.
     */
    export function registerChatSessionContentProvider(
      scheme: string,
      provider: ChatSessionContentProvider,
      defaultChatParticipant: ChatParticipant,
      capabilities?: ChatSessionCapabilities,
    ): Disposable;
  }
}
