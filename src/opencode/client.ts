/**
 * Thin wrapper around the SDK client obtained from createOpencode().
 * The actual client instance comes from OpenCodeServerManager.getClient().
 * This module provides typed helper functions for common operations.
 */

export interface SessionData {
  id: string;
  title: string;
  createdAt: Date;
}

/** Extract a single session's data from an SDK response */
export function extractSession(result: any): SessionData {
  const data = result?.data ?? result;
  return {
    id: data.id,
    title: data.title ?? '',
    createdAt: new Date(data.time?.created ?? Date.now()),
  };
}

/** Extract a session list from an SDK response */
export function extractSessions(result: any): SessionData[] {
  const list = result?.data ?? result;
  if (!Array.isArray(list)) return [];
  return list.map(extractSession);
}
