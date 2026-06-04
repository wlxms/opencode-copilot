/**
 * ACP event-stream serializer (v2 JSONL format).
 *
 * Each line is a JSON object of the form:
 *   {"v":2,"t":"<type>","d":<data>}
 *
 * Line types:
 *   version   — format version marker
 *   meta      — session metadata (v1)
 *   event     — ACP events (v2)
 *   snapshot  — file snapshot records (v2)
 *
 * No VSCode or SDK imports — plain Node.js only.
 */

import { promises as fs } from 'node:fs';

// ===========================================================================
// Line builders / parsers
// ===========================================================================

const LINE_TYPES = {
  VERSION: 'version',
  META: 'meta',
  EVENT: 'event',
  SNAPSHOT: 'snapshot',
} as const;

interface ParsedLine {
  v: number;
  t: string;
  d: unknown;
}

/**
 * Build a JSONL line in the v2 format.
 *
 * @param type - The line type discriminator
 * @param data - The payload to serialize
 * @returns A newline-terminated JSON string
 */
export function buildLine(type: string, data: unknown): string {
  return JSON.stringify({ v: 2, t: type, d: data }) + '\n';
}

/**
 * Parse a single JSONL line.
 *
 * @param line - Raw line string
 * @returns The parsed line object, or `null` if the line is empty/invalid
 */
export function parseLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as ParsedLine;
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof parsed.v !== 'number') return null;
    if (typeof parsed.t !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

// ===========================================================================
// v1 serialization (version header, metadata)
// ===========================================================================

/**
 * Write a version header line to a JSONL file.
 * Overwrites the file (use once at session start).
 *
 * @param filePath - Absolute path to the session file
 */
export async function writeVersionHeader(filePath: string): Promise<void> {
  await fs.writeFile(filePath, buildLine(LINE_TYPES.VERSION, '2.0'), 'utf-8');
}

/**
 * Append a metadata line to a JSONL file.
 *
 * @param filePath - Absolute path to the session file
 * @param meta     - Key-value metadata payload
 */
export async function writeMeta(
  filePath: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await fs.appendFile(filePath, buildLine(LINE_TYPES.META, meta), 'utf-8');
}

/**
 * Read and return all metadata records from a JSONL file.
 *
 * @param filePath - Absolute path to the session file
 * @returns Array of metadata objects
 */
export async function readSessionMeta(
  filePath: string,
): Promise<Record<string, unknown>[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  if (!content.trim()) return [];

  const records: Record<string, unknown>[] = [];
  for (const raw of content.split('\n')) {
    const parsed = parseLine(raw);
    if (!parsed) continue;
    if (parsed.t === LINE_TYPES.META) {
      records.push(parsed.d as Record<string, unknown>);
    }
  }
  return records;
}

/**
 * Write session metadata to a JSONL file. Alias for writeMeta.
 *
 * @param filePath - Absolute path to the session file
 * @param meta     - Key-value metadata payload
 */
export async function writeSessionMeta(
  filePath: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await writeMeta(filePath, meta);
}

// ===========================================================================
// v2 serialization (events, snapshots)
// ===========================================================================

/**
 * Write a single AcpEvent as a JSONL line (append-mode).
 *
 * @param filePath - Absolute path to the session events file
 * @param event    - The ACP event to persist
 */
export async function writeEvent(
  filePath: string,
  event: unknown,
): Promise<void> {
  await fs.appendFile(
    filePath,
    buildLine(LINE_TYPES.EVENT, event),
    'utf-8',
  );
}

/**
 * Write a file snapshot as a JSONL line (append-mode).
 *
 * @param filePath - Absolute path to the snapshot file
 * @param snapshot - The file snapshot record to persist
 */
export async function writeSnapshotLine(
  filePath: string,
  snapshot: unknown,
): Promise<void> {
  await fs.appendFile(
    filePath,
    buildLine(LINE_TYPES.SNAPSHOT, snapshot),
    'utf-8',
  );
}

/**
 * Read all AcpEvents from a JSONL file.
 *
 * @param filePath - Absolute path to the session events file
 * @returns Array of deserialized ACP events
 */
export async function readSessionEvents<T = unknown>(
  filePath: string,
): Promise<T[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  if (!content.trim()) return [];

  const events: T[] = [];
  for (const raw of content.split('\n')) {
    const parsed = parseLine(raw);
    if (!parsed) continue;
    if (parsed.t === LINE_TYPES.EVENT) {
      events.push(parsed.d as T);
    }
  }
  return events;
}

/**
 * Read all FileSnapshotRecords from a JSONL file.
 *
 * @param filePath - Absolute path to the snapshot file
 * @returns Array of deserialized file snapshot records
 */
export async function readSessionSnapshots<T = unknown>(
  filePath: string,
): Promise<T[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  if (!content.trim()) return [];

  const snapshots: T[] = [];
  for (const raw of content.split('\n')) {
    const parsed = parseLine(raw);
    if (!parsed) continue;
    if (parsed.t === LINE_TYPES.SNAPSHOT) {
      snapshots.push(parsed.d as T);
    }
  }
  return snapshots;
}
