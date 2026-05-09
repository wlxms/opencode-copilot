import { describe, it, expect } from 'vitest';
import { extractSession, extractSessions } from '../opencode/client';
import type { SessionData } from '../opencode/client';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractSession', () => {
  // -----------------------------------------------------------------------
  // Basic extraction
  // -----------------------------------------------------------------------

  it('should extract SessionData from a valid SDK result', () => {
    const result = extractSession({
      data: {
        id: 'session-1',
        title: 'My Session',
        time: { created: 1700000000000 },
      },
    });

    expect(result.id).toBe('session-1');
    expect(result.title).toBe('My Session');
    expect(result.createdAt).toEqual(new Date(1700000000000));
  });

  it('should default title to empty string when missing', () => {
    const result = extractSession({
      data: {
        id: 'session-2',
        time: { created: 1700000000000 },
      },
    });

    expect(result.id).toBe('session-2');
    expect(result.title).toBe('');
    expect(result.createdAt).toEqual(new Date(1700000000000));
  });

  it('should default createdAt to now when time is missing', () => {
    const before = Date.now();
    const result = extractSession({
      data: {
        id: 'session-3',
        title: 'No Time',
      },
    });
    const after = Date.now();

    expect(result.id).toBe('session-3');
    expect(result.title).toBe('No Time');
    expect(result.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.createdAt.getTime()).toBeLessThanOrEqual(after);
  });

  it('should default createdAt to now when time.created is missing', () => {
    const before = Date.now();
    const result = extractSession({
      data: {
        id: 's4',
        title: 'T',
        time: {},
      },
    });
    const after = Date.now();

    expect(result.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.createdAt.getTime()).toBeLessThanOrEqual(after);
  });

  // -----------------------------------------------------------------------
  // Edge cases – null / undefined data
  // -----------------------------------------------------------------------

  it('should fall back when result.data is null', () => {
    const before = Date.now();
    const result = extractSession({ data: null });
    const after = Date.now();

    expect(result.title).toBe('');
    expect(result.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.createdAt.getTime()).toBeLessThanOrEqual(after);
  });

  it('should fall back when result.data is undefined', () => {
    const result = extractSession({ data: undefined });

    expect(result.title).toBe('');
  });

  it('should treat a plain object without data wrapper as the data itself', () => {
    const result = extractSession({
      id: 'direct',
      title: 'Direct Object',
      time: { created: 999 },
    });

    expect(result.id).toBe('direct');
    expect(result.title).toBe('Direct Object');
    expect(result.createdAt).toEqual(new Date(999));
  });

  // -----------------------------------------------------------------------
  // Return type
  // -----------------------------------------------------------------------

  it('should return a SessionData-shaped object', () => {
    const result = extractSession({
      data: { id: 's', title: 't', time: { created: 100 } },
    });

    const sd: SessionData = result;
    expect(sd).toBeDefined();
  });
});

describe('extractSessions', () => {
  // -----------------------------------------------------------------------
  // Basic extraction
  // -----------------------------------------------------------------------

  it('should extract an array of SessionData from a valid list result', () => {
    const result = extractSessions({
      data: [
        { id: 's1', title: 'One', time: { created: 100 } },
        { id: 's2', title: 'Two', time: { created: 200 } },
      ],
    });

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('s1');
    expect(result[0].title).toBe('One');
    expect(result[0].createdAt).toEqual(new Date(100));
    expect(result[1].id).toBe('s2');
    expect(result[1].title).toBe('Two');
    expect(result[1].createdAt).toEqual(new Date(200));
  });

  it('should return an empty array for null data', () => {
    const result = extractSessions({ data: null });

    expect(result).toEqual([]);
  });

  it('should return an empty array for undefined data', () => {
    const result = extractSessions({ data: undefined });

    expect(result).toEqual([]);
  });

  it('should return an empty array for non-array data', () => {
    const result = extractSessions({ data: { not: 'an array' } });

    expect(result).toEqual([]);
  });

  it('should return an empty array for an empty data array', () => {
    const result = extractSessions({ data: [] });

    expect(result).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Plain object without data wrapper
  // -----------------------------------------------------------------------

  it('should treat a plain array without data wrapper as the list', () => {
    const result = extractSessions([
      { id: 'a', title: 'A', time: { created: 1 } },
      { id: 'b', title: 'B', time: { created: 2 } },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('a');
    expect(result[1].id).toBe('b');
  });

  it('should return empty array for non-array plain value', () => {
    const result = extractSessions('not an array');

    expect(result).toEqual([]);
  });
});
