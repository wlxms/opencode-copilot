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
   * Represents the current state of user inputs for a chat session.
   */
  export interface ChatSessionInputState {
    /**
     * Fired when the input state is disposed.
     */
    readonly onDidDispose: Event<void>;

    /**
     * Fired when the input state is changed by the user.
     */
    readonly onDidChange: Event<void>;

    /**
     * The resource associated with this chat session.
     */
    readonly sessionResource: Uri | undefined;

    /**
     * The groups of options to show in the UI for user input.
     *
     * To update the groups you must replace the entire `groups` array with a new array.
     */
    groups: readonly ChatSessionProviderOptionGroup[];
  }

  // ---------------------------------------------------------------------------
  // ChatSession
  // ---------------------------------------------------------------------------

  /**
   * Represents a chat session returned by `provideChatSessionContent`.
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
     */
    readonly activeResponseCallback?: (
      stream: ChatResponseStream,
      token: CancellationToken,
    ) => Thenable<void>;

    /**
     * Handles new request for the session.
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
  // ChatSessionProviderOptions
  // ---------------------------------------------------------------------------

  /**
   * Options returned by provideChatSessionProviderOptions.
   */
  export interface ChatSessionProviderOptions {
    /**
     * Provider-defined option groups (0-2 groups supported).
     */
    readonly optionGroups?: readonly ChatSessionProviderOptionGroup[];

    /**
     * The set of default options used for new chat sessions.
     */
    readonly newSessionOptions?: Record<string, string | ChatSessionProviderOptionItem>;
  }

  // ---------------------------------------------------------------------------
  // ChatSessionContentProvider
  // ---------------------------------------------------------------------------

  /**
   * Provides content for chat sessions of a specific type (URI scheme).
   */
  export interface ChatSessionContentProvider {
    /**
     * Provide the content for a chat session identified by its resource URI.
     */
    provideChatSessionContent(
      resource: Uri,
      token: CancellationToken,
      context: { readonly inputState: ChatSessionInputState },
    ): Thenable<ChatSession> | ChatSession;

    /**
     * @deprecated
     *
     * Event that the provider can fire to signal that the available provider options have changed.
     * When fired, the editor will re-query provideChatSessionProviderOptions.
     */
    readonly onDidChangeChatSessionProviderOptions?: Event<void>;

    /**
     * Called as soon as you register (call me once).
     * Returns option groups and default session options.
     */
    provideChatSessionProviderOptions?(
      token: CancellationToken,
    ): Thenable<ChatSessionProviderOptions>;
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
