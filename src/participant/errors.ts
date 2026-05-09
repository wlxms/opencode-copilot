/**
 * Custom error types and user-friendly messages for OpenCode participant.
 */

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * Base error for OpenCode server errors.
 */
export class OpenCodeServerError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'OpenCodeServerError';
  }
}

/**
 * Session creation or message sending failed.
 */
export class SessionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'SessionError';
  }
}

/**
 * SSE or streaming connection failed.
 */
export class StreamingError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'StreamingError';
  }
}

/**
 * Configuration is invalid (missing binary, bad config, etc.)
 */
export class ConfigurationError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

// ---------------------------------------------------------------------------
// User-facing messages
// ---------------------------------------------------------------------------

/**
 * User-friendly error messages for each scenario.
 */
export const ErrorMessages = {
  SERVER_START_TIMEOUT: '⚠️ OpenCode server failed to start. Is opencode installed? Install: `npm i -g opencode-ai`',
  SERVER_BINARY_NOT_FOUND: '⚠️ OpenCode CLI not found. Install with: `npm i -g opencode-ai`',
  AUTH_ERROR: '⚠️ Authentication error. Please check your OpenCode configuration.',
  SESSION_ERROR: '⚠️ Session error. Please try starting a new session with **/new**.',
  STREAM_CONNECTION_LOST: '⚠️ Connection to OpenCode server lost. Please try again.',
  EMPTY_PROMPT: '💡 Please type a message or use **/help** to see available commands.',
  GENERIC_ERROR: '⚠️ An unexpected error occurred. Please try again.',
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map an error to a user-friendly message for display in chat.
 */
export function toUserMessage(error: unknown): string {
  if (error instanceof OpenCodeServerError) {
    if (error.message.includes('timeout') || error.message.includes('failed to start')) {
      return ErrorMessages.SERVER_START_TIMEOUT;
    }
    if (error.message.includes('not found') || error.message.includes('ENOENT')) {
      return ErrorMessages.SERVER_BINARY_NOT_FOUND;
    }
    return `⚠️ Server error: ${error.message}`;
  }
  if (error instanceof SessionError) {
    return `⚠️ Session error: ${error.message}`;
  }
  if (error instanceof StreamingError) {
    return ErrorMessages.STREAM_CONNECTION_LOST;
  }
  if (error instanceof ConfigurationError) {
    return `⚠️ Configuration error: ${error.message}`;
  }
  return ErrorMessages.GENERIC_ERROR;
}

/**
 * Check if a prompt is empty (whitespace only).
 * Returns true if the prompt is empty — caller should show help.
 */
export function isEmptyPrompt(prompt: string | undefined): boolean {
  return !prompt || prompt.trim().length === 0;
}
