import { describe, it, expect } from 'vitest';

describe('Extension', () => {
  it('should export activate and deactivate functions', async () => {
    const ext = await import('../extension');
    expect(typeof ext.activate).toBe('function');
    expect(typeof ext.deactivate).toBe('function');
  });
});
