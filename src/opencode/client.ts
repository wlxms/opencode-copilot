/**
 * Thin wrapper around the SDK client obtained from createOpencode().
 * The actual client instance comes from OpenCodeServerManager.getClient().
 * This module provides typed helper functions for common operations.
 */

interface SessionLike {
  id?: string;
  title?: string;
  time?: { created?: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function unwrapData(result: unknown): unknown {
  if (isRecord(result) && 'data' in result) {
    return result.data;
  }
  return result;
}

function asSessionLike(value: unknown): SessionLike {
  return isRecord(value) ? value : {};
}

export interface SessionData {
  id: string;
  title: string;
  createdAt: Date;
}

/** Extract a single session's data from an SDK response */
export function extractSession(result: unknown): SessionData {
  const data = asSessionLike(unwrapData(result));
  return {
    id: data.id ?? '',
    title: data.title ?? '',
    createdAt: new Date(data.time?.created ?? Date.now()),
  };
}

/** Extract a session list from an SDK response */
export function extractSessions(result: unknown): SessionData[] {
  const list = unwrapData(result);
  if (!Array.isArray(list)) {return [];}
  return list.map(extractSession);
}
