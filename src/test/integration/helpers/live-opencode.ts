import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';

import { OpenCodeBackend } from '../../../backends/opencode/adapter';
import { OpenCodeServerManager } from '../../../opencode/server';
import type { AcpEvent } from '../../../acp/types';

export interface LiveOpenCodeHarness {
  directory: string;
  backend: OpenCodeBackend;
  serverManager: OpenCodeServerManager;
  dispose(): Promise<void>;
}

/**
 * Watches an ACP event stream and provides promise-based wait-for-event semantics.
 *
 * Consumption starts immediately on construction, buffering events so that
 * callers can call `waitForEvent` even after the event has already arrived.
 */
export class StreamMonitor {
  private buffer: AcpEvent[] = [];
  private waiters: Map<string, Array<(e: AcpEvent) => void>> = new Map();
  private consumePromise: Promise<void>;
  private ended = false;

  constructor(stream: AsyncIterable<AcpEvent>) {
    this.consumePromise = this.consume(stream);
  }

  private async consume(stream: AsyncIterable<AcpEvent>): Promise<void> {
    try {
      for await (const event of stream) {
        this.buffer.push(event);
        const eventType = event.type;
        const handlers = this.waiters.get(eventType) ?? [];
        if (handlers.length > 0) {
          this.waiters.set(eventType, []);
          for (const h of handlers) {
            h(event);
          }
        }
      }
    } finally {
      this.ended = true;
      // Drain all remaining waiters so they don't hang
      for (const [, handlers] of this.waiters) {
        for (const h of handlers) {
          h({ type: 'server.connected' }); // sentinel — caller must check
        }
        handlers.length = 0;
      }
    }
  }

  /** Return the first event of the given type seen so far, or wait for one up to `timeoutMs`. */
  async waitForEvent(eventType: string, timeoutMs: number): Promise<AcpEvent | null> {
    // Check buffer first
    const existing = this.buffer.find((e) => e.type === eventType);
    if (existing) {return existing;}

    // If stream already ended, give up immediately
    if (this.ended) {return null;}

    // Wait for it
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(null);
      }, timeoutMs);

      const handlers = this.waiters.get(eventType) ?? [];
      handlers.push((e: AcpEvent) => {
        clearTimeout(timer);
        // Distinguish sentinel from real event
        if (this.ended && e.type !== eventType) {
          resolve(null);
        } else {
          resolve(e);
        }
      });
      this.waiters.set(eventType, handlers);
    });
  }

  /** Wait for any of the given event types. Returns the first one seen. */
  async waitForAnyEvent(types: string[], timeoutMs: number): Promise<AcpEvent | null> {
    for (const t of types) {
      const existing = this.buffer.find((e) => e.type === t);
      if (existing) {return existing;}
    }
    if (this.ended) {return null;}

    return new Promise((resolve) => {
      const timer = setTimeout(() => { resolve(null); }, timeoutMs);

      for (const eventType of types) {
        const handlers = this.waiters.get(eventType) ?? [];
        handlers.push((e: AcpEvent) => {
          clearTimeout(timer);
          // Clear all waiters across all types
          for (const [, v] of this.waiters) {
            v.length = 0;
          }
          if (this.ended && !types.includes(e.type)) {
            resolve(null);
          } else {
            resolve(e);
          }
        });
        this.waiters.set(eventType, handlers);
      }
    });
  }

  /** Wait for the underlying stream to fully end (or timeout). */
  async waitForEnd(timeoutMs: number): Promise<void> {
    const timer = new Promise<void>((_, reject) =>
      setTimeout(() => { reject(new Error(`Stream did not end within ${timeoutMs}ms`)); }, timeoutMs),
    );
    await Promise.race([this.consumePromise, timer]);
  }

  getAllEvents(): AcpEvent[] {
    return [...this.buffer];
  }

  /** Filter events by type. Deep-copies from buffer. */
  eventsByType<T extends AcpEvent['type']>(
    type: T,
  ): Extract<AcpEvent, { type: T }>[] {
    return this.buffer.filter((e): e is Extract<AcpEvent, { type: T }> => e.type === type);
  }

  isEnded(): boolean {
    return this.ended;
  }
}

/**
 * Helper: check whether the target file was modified on disk.
 * Returns the new content if different from original, null if unchanged/missing.
 */
export function checkFileModified(filePath: string, originalContent: string): string | null {
  if (!existsSync(filePath)) {return null;}
  const current = readFileSync(filePath, 'utf-8');
  return current !== originalContent ? current : null;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupDirectory(directory: string): Promise<void> {
  let lastError: unknown;

  for (const waitMs of [0, 100, 300, 800]) {
    if (waitMs > 0) {
      await delay(waitMs);
    }

    try {
      rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    // Do not fail the whole integration run because Windows sometimes releases
    // temp handles asynchronously after server shutdown. Leave the temp dir behind
    // as evidence for investigation.
    console.warn(`[integration] failed to clean temp project ${directory}: ${String(lastError)}`);
  }
}

export function createTempProject(prefix = 'opencode-copilot-live'): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'live-probe', private: true }, null, 2));
  writeFileSync(join(dir, 'README.md'), '# live probe\n');
  writeFileSync(
    join(dir, 'opencode.json'),
    JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      permission: {
        edit: 'ask',
        bash: 'deny',
        read: 'allow',
      },
    }, null, 2),
  );
  return dir;
}

export async function createLiveHarness(projectDir?: string): Promise<LiveOpenCodeHarness> {
  const directory = projectDir ?? createTempProject();

  const backend = new OpenCodeBackend();

  const start = await backend.start(directory);
  if (start.error) {
    throw new Error(`Failed to start live backend: ${String(start.error)}`);
  }

  const serverManager = new OpenCodeServerManager();

  return {
    directory,
    backend,
    serverManager,
    async dispose() {
      await backend.stop().catch(() => undefined);
      await cleanupDirectory(directory);
    },
  };
}

/**
 * Create a temp project with a target source file that can be prompted for editing.
 * The project includes `package.json`, `README.md`, and the given source file.
 *
 * @param targetFile - Relative file path inside the project (e.g. `src/hello.ts`)
 * @param targetContent - Initial file content
 * @returns The project directory path
 */
export function createTempProjectWithTargetFile(
  targetFile: string,
  targetContent: string,
): string {
  const dir = createTempProject();
  const fullPath = join(dir, targetFile);
  const parent = dirname(fullPath);
  if (parent !== dir) {
    mkdirSync(parent, { recursive: true });
  }
  writeFileSync(fullPath, targetContent, 'utf-8');
  return dir;
}

export function extractTransportPayload(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return value;
  }

  const maybeRecord = value as Record<string, unknown>;
  if ('data' in maybeRecord || 'error' in maybeRecord) {
    return maybeRecord;
  }

  if ('request' in maybeRecord || 'response' in maybeRecord) {
    return maybeRecord;
  }

  return maybeRecord;
}
