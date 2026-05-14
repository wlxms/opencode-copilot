import { describe, it, expect, vi, afterEach } from 'vitest';
import { Gate } from '../participant/gate';

// ---------------------------------------------------------------------------
// Gate unit tests
// ---------------------------------------------------------------------------

describe('Gate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // resolve
  // -------------------------------------------------------------------------

  it('resolve() settles the promise', async () => {
    const gate = new Gate(Infinity);

    let settled = false;
    gate.promise.then(() => { settled = true; });

    gate.resolve();
    await gate.promise;

    expect(settled).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Timeout auto-resolves
  // -------------------------------------------------------------------------

  it('timeout auto-resolves the gate', async () => {
    vi.useFakeTimers();

    const gate = new Gate(1000);
    expect(gate.resolved).toBe(false);

    vi.advanceTimersByTime(1000);

    // Allow the resolved promise microtask to process
    await vi.waitFor(() => {
      expect(gate.resolved).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // dispose
  // -------------------------------------------------------------------------

  it('dispose() resolves and clears timer', async () => {
    const gate = new Gate(Infinity);

    expect(gate.resolved).toBe(false);
    gate.dispose();

    expect(gate.resolved).toBe(true);
    await gate.promise; // should settle immediately
  });

  // -------------------------------------------------------------------------
  // Idempotent resolve
  // -------------------------------------------------------------------------

  it('resolve() is idempotent — second call is a no-op', async () => {
    const gate = new Gate(Infinity);

    let count = 0;
    gate.promise.then(() => { count++; });

    gate.resolve();
    gate.resolve(); // second call should be no-op

    await gate.promise;
    expect(count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // resolved property
  // -------------------------------------------------------------------------

  it('resolved property reflects state', () => {
    const gate = new Gate(Infinity);

    expect(gate.resolved).toBe(false);
    gate.resolve();
    expect(gate.resolved).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Multiple independent Gates
  // -------------------------------------------------------------------------

  it('multiple gates operate independently', async () => {
    const gate1 = new Gate(Infinity);
    const gate2 = new Gate(Infinity);

    let settled1 = false;
    let settled2 = false;
    gate1.promise.then(() => { settled1 = true; });
    gate2.promise.then(() => { settled2 = true; });

    gate1.resolve();
    await gate1.promise;

    expect(settled1).toBe(true);
    expect(gate1.resolved).toBe(true);

    expect(settled2).toBe(false);
    expect(gate2.resolved).toBe(false);
  });
});
