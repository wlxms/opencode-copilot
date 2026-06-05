import type { ExtensionState } from '../types';

export interface ApplySessionTitleOptions {
  sessionId: string;
  vscodeSessionId?: string;
  title: string | undefined;
  directory?: string;
  createdAt?: Date;
  updateBackend?: boolean;
  overwrite?: boolean;
  emitListChanged?: boolean;
  source?: string;
}

function isPlaceholderSessionTitle(title: string | undefined): boolean {
  const normalized = title?.trim() ?? '';
  return !normalized
    || normalized === 'New OpenCode Session'
    || normalized.startsWith('OpenCode Session ')
    || normalized.startsWith('Session ');
}

/**
 * Keep the three title surfaces in sync:
 * backend session, in-memory VS Code session mapping, and SessionStore metadata.
 */
export async function applySessionTitle(
  state: ExtensionState,
  options: ApplySessionTitleOptions,
): Promise<string | undefined> {
  let title = options.title?.replace(/\s+/g, ' ').trim();
  if (!title || isPlaceholderSessionTitle(title)) {
    return undefined;
  }

  const logger = state.outputChannel;

  if (options.updateBackend) {
    try {
      const updateResult = await state.backend.sessions.update(options.sessionId, {
        title,
        directory: options.directory,
      });
      title = updateResult.data?.title?.trim() || title;
      logger.appendLine(
        `[session-title] Backend title updated (${options.source ?? 'unknown'}): "${title}"`,
      );
    } catch (err) {
      logger.appendLine(
        `[session-title] Backend title update failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  let createdAt = options.createdAt;
  const updateState = (stateKey?: string) => {
    if (!stateKey) return;
    const sessionState = state.sessions.get(stateKey);
    if (!sessionState || sessionState.sessionId !== options.sessionId) return;
    createdAt = createdAt ?? sessionState.createdAt;
    if (options.overwrite || isPlaceholderSessionTitle(sessionState.title)) {
      sessionState.title = title;
    }
  };

  updateState(options.vscodeSessionId);
  for (const sessionState of state.sessions.values()) {
    if (sessionState.sessionId !== options.sessionId) continue;
    createdAt = createdAt ?? sessionState.createdAt;
    if (options.overwrite || isPlaceholderSessionTitle(sessionState.title)) {
      sessionState.title = title;
    }
  }

  try {
    await state.sessionStore.writeMeta(options.sessionId, {
      id: options.sessionId,
      title,
      createdAt: (createdAt ?? new Date()).toISOString(),
      backendName: state.backend.name,
    });
  } catch (err) {
    logger.appendLine(
      `[session-title] SessionStore title write failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (options.emitListChanged !== false) {
    state.bus.emit('session-list-changed', void 0);
  }
  return title;
}
