/**
 * Vitest mock for the `vscode` module.
 *
 * The `vscode` module is a virtual module provided by VS Code's extension host
 * at runtime — it does NOT exist as an installable npm package. Vitest (running
 * in node) cannot resolve `import * as vscode from 'vscode'` without this mock.
 *
 * This mock provides only the minimal surface area needed by the unit tests.
 * It is NOT a full VS Code API polyfill.
 */

import type { ChatToolSpecificData, ChatToolInvocationStreamData } from '../types/vscode-proposed-additions';

// ---------------------------------------------------------------------------
// Enums / Constants
// ---------------------------------------------------------------------------

export enum ChatResultFeedbackKind {
    Helpful = 1,
    Unhelpful = 2,
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

export class ThemeIcon {
    constructor(
        public id: string,
        public color?: ThemeColor,
    ) {}
}

export class ThemeColor {
    constructor(public id: string) {}
}

export enum ChatSessionStatus {
    Failed = 0,
    Completed = 1,
    InProgress = 2,
    NeedsInput = 3,
}

export class OutputChannel {
    public readonly lines: string[] = [];

    constructor(public readonly name: string) {}

    appendLine(message: string): void {
        this.lines.push(message);
    }

    append(_message: string): void {
        // no-op for tests
    }

    clear(): void {
        this.lines.length = 0;
    }

    show(_preserveFocus?: boolean): void {
        // no-op for tests
    }

    hide(): void {
        // no-op for tests
    }

    dispose(): void {
        this.lines.length = 0;
    }
}

export class EventEmitter<T> {
    private listeners: Array<(value: T) => unknown> = [];

    readonly event = (listener: (value: T) => unknown): { dispose(): void } => {
        this.listeners.push(listener);
        return {
            dispose: () => {
                this.listeners = this.listeners.filter(l => l !== listener);
            },
        };
    };

    fire(value: T): void {
        for (const listener of this.listeners) {
            listener(value);
        }
    }

    dispose(): void {
        this.listeners = [];
    }
}

export class ChatParticipant {
    public iconPath: ThemeIcon | { light: ThemeIcon; dark: ThemeIcon } | undefined;
    private _feedbackListeners: Array<(e: ChatResultFeedback) => unknown> = [];

    constructor(
        public readonly id: string,
        public readonly handler: ChatRequestHandler,
    ) {}

    onDidReceiveFeedback(
        listener: (e: ChatResultFeedback) => unknown,
    ): { dispose(): void } {
        this._feedbackListeners.push(listener);
        return { dispose: () => { /* no-op */ } };
    }

    dispose(): void {
        this._feedbackListeners = [];
    }
}

export class LanguageModelTextPart {
    constructor(public readonly value: string) {}
}

export interface LanguageModelChatCapabilities {
    readonly imageInput?: boolean;
    readonly toolCalling?: boolean | number;
}

export interface LanguageModelChatInformation {
    readonly id: string;
    readonly name: string;
    readonly family: string;
    readonly version: string;
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
    readonly capabilities: LanguageModelChatCapabilities;
    readonly targetChatSessionType?: string;
    readonly isUserSelectable?: boolean;
    readonly isDefault?: boolean | Record<string, boolean>;
}

export interface LanguageModelChat {
    readonly id: string;
    readonly family: string;
    readonly vendor?: string;
    readonly name?: string;
    readonly version?: string;
}

// ---------------------------------------------------------------------------
// Interfaces (minimal shape for unit tests)
// ---------------------------------------------------------------------------

/** Promise-like interface (from VS Code API) */
export interface Thenable<T> {
    then<TResult1 = T, TResult2 = never>(
        onfulfilled?: ((value: T) => TResult1 | Thenable<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | Thenable<TResult2>) | null,
    ): Thenable<TResult1 | TResult2>;
}

export interface ExtensionContext {
    subscriptions: Array<{ dispose(): void }>;
    extensionPath: string;
    extensionUri: Uri;
    globalState: Memento;
    workspaceState: Memento;
    storageUri: Uri | undefined;
    globalStorageUri: Uri;
    logUri: Uri;
}

export class Uri {
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly fragment: string;
    readonly query: string;
    readonly fsPath: string;

    static file(path: string): Uri {
        return new Uri('file', '', path, '', '');
    }

    static parse(value: string): Uri {
        if (/^[a-zA-Z][a-zA-Z\d+.-]*:\//.test(value)) {
            const parsed = new URL(value);
            return new Uri(
                parsed.protocol.slice(0, -1),
                parsed.host,
                parsed.pathname,
                parsed.search.startsWith('?') ? parsed.search.slice(1) : parsed.search,
                parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash,
            );
        }

        // basic fallback — enough for tests
        return new Uri('file', '', value, '', '');
    }

    constructor(scheme: string, authority: string, path: string, query: string, fragment: string) {
        this.scheme = scheme;
        this.authority = authority;
        this.path = path;
        this.query = query;
        this.fragment = fragment;
        this.fsPath = path.replace(/\//g, '\\');
    }

    with(_change: unknown): this {
        return this;
    }

    toString(): string {
        return `${this.scheme}://${this.authority}${this.path}`;
    }
}

export interface Memento {
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Thenable<void>;
}

export type ChatRequestHandler = (
    request: ChatRequest,
    context: ChatContext,
    stream: ChatResponseStream,
    token: CancellationToken,
) => Promise<ChatResult>;

export interface ChatRequest {
    prompt: string;
    command: string | undefined;
    references: Array<unknown>;
    toolReferences?: unknown[];
    toolInvocationToken?: string;
    model?: unknown;
    /** From chatParticipantPrivate proposed API — identifies the VSCode chat panel */
    sessionId?: string;
}

export interface ChatContext {
    history: Array<unknown>;
}

/**
 * Minimal MarkdownString mock — needed by streaming.ts formatPastTenseMsg / formatFileBubbleMessage.
 * The real class concatenates markdown; for tests a plain string container suffices.
 */
export class MarkdownString {
    value: string;
    constructor(value: string) { this.value = value; }
    toString() { return this.value; }
}

export class ChatResponseMarkdownPart {
    constructor(public readonly value: MarkdownString | string) {}
}

/**
 * Mock for proposed API: ChatToolInvocationPart
 * This is NOT in @types/vscode — available at runtime with chatParticipantAdditions.
 */
export class ChatToolInvocationPart {
    toolName: string;
    toolCallId: string;
    isError?: boolean;
    invocationMessage?: string;
    originMessage?: string;
    pastTenseMessage?: string;
    isConfirmed?: boolean;
    isComplete?: boolean;
    toolSpecificData?: ChatToolSpecificData;
    subAgentInvocationId?: string;
    presentation?: 'hidden' | 'hiddenAfterComplete';
    enablePartialUpdate?: boolean;

    constructor(toolName: string, toolCallId: string, errorMessage?: string) {
        this.toolName = toolName;
        this.toolCallId = toolCallId;
        this.isError = !!errorMessage;
    }
}

export interface ChatResponseStream {
    markdown(value: string): void;
    progress(value: string): void;
    push(part: unknown): void;
    anchor?(value: unknown, title?: string): void;
    button?(command: unknown): void;
    filetree?(value: unknown, baseUri?: unknown): void;
    reference?(value: unknown, iconPath?: unknown): void;
    /** Proposed API: stream thinking tokens */
    thinkingProgress?(delta: unknown): void;
    /** Proposed API: begin streaming tool invocation */
    beginToolInvocation?(toolCallId: string, toolName: string, streamData?: ChatToolInvocationStreamData): void;
    /** Proposed API: update streaming tool invocation */
    updateToolInvocation?(toolCallId: string, streamData: ChatToolInvocationStreamData): void;
}

export interface CancellationToken {
    isCancellationRequested: boolean;
    onCancellationRequested: (listener: () => unknown) => { dispose(): void };
}

export interface ChatResult {
    metadata: Record<string, unknown>;
}

export interface ChatSessionItem {
    readonly resource: Uri;
    label: string;
    iconPath?: unknown;
    description?: string;
    badge?: string;
    status?: ChatSessionStatus;
    tooltip?: string;
    timing?: { readonly created: number };
}

export interface ChatResultFeedback {
    readonly kind: ChatResultFeedbackKind;
    readonly result: ChatResult;
}

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

export const window = {
    createOutputChannel(name: string): OutputChannel {
        return new OutputChannel(name);
    },
};

export const chat = {
    createChatParticipant(
        id: string,
        handler: ChatRequestHandler,
    ): ChatParticipant {
        return new ChatParticipant(id, handler);
    },
    createChatSessionItemController(
        id: string,
        refreshHandler: (token: CancellationToken) => Promise<void> | Thenable<void>,
    ) {
        const items = new Map<string, ChatSessionItem>();
        return {
            id,
            refreshHandler,
            items: {
                get size() {
                    return items.size;
                },
                replace(iterable: Iterable<ChatSessionItem>) {
                    items.clear();
                    for (const item of iterable) {
                        items.set(item.resource.toString(), item);
                    }
                },
                add(item: ChatSessionItem) {
                    items.set(item.resource.toString(), item);
                },
                delete(resource: Uri) {
                    items.delete(resource.toString());
                },
                get(resource: Uri) {
                    return items.get(resource.toString());
                },
                [Symbol.iterator]() {
                    return Array.from(items.values(), item => [item.resource, item] as const)[Symbol.iterator]();
                },
            },
            createChatSessionItem(resource: Uri, label: string): ChatSessionItem {
                return { resource, label };
            },
            createChatSessionInputState(groups: unknown[]) {
                return {
                    sessionResource: undefined,
                    groups,
                    onDidDispose: () => ({ dispose() {} }),
                    onDidChange: () => ({ dispose() {} }),
                };
            },
            dispose() {
                items.clear();
            },
        };
    },
};

export const lm = {
    registerLanguageModelChatProvider(_vendor: string, _provider: unknown) {
        return { dispose() {} };
    },
};

export const workspace = {
    workspaceFolders: undefined as Array<{ uri: Uri; name: string; index: number }> | undefined,
};

// ---------------------------------------------------------------------------
// Turn types for chat history
// ---------------------------------------------------------------------------

export class ChatRequestTurn {
    constructor(
        public readonly prompt: string,
        public readonly command: string | undefined,
        public readonly references: Array<{ id: string; name: string }> = [],
        public readonly participant: string = 'opencode',
        public readonly toolReferences: readonly unknown[] = [],
    ) {}
}

export class ChatResponseTurn {
    constructor(
        public readonly responses: unknown[],
        public readonly result?: ChatResult,
    ) {}
};
