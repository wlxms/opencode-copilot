/**
 * VS Code surface abstractions for the ACP-first refactor.
 *
 * This module separates rendering concerns from OpenCode wire protocol
 * management, providing:
 *
 * - `capabilities`     — Runtime gating helpers for proposed/experimental APIs
 * - `acp-renderer`     — Pure ACP event → VS Code output renderer
 * - `stable-participant` — Participant handler using only stable chat APIs
 * - `experimental-session` — Future `registerChatSessionContentProvider` surface
 *
 * == Architecture ==
 * ```
 * Wire Protocol (StreamBridge / handler.ts)
 *     │
 *     ▼  (OpenCodeEvent[])
 * ┌─────────────────────────────────────┐
 * │         AcpRenderer                │
 * │  (pure rendering, no wire logic)   │
 * └──────────┬──────────────────────────┘
 *            │
 *     ┌──────┴──────┐
 *     ▼              ▼
 *  Stable         Experimental
 *  Surface        Surface
 *  (markdown      (ChatSession
 *   only)         ContentProvider)
 * ```
 *
 * @module
 */
export * from './capabilities';
export * from './acp-renderer';
export * from './stable-participant';
export * from './experimental-session';
