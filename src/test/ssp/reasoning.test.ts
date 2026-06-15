import { describe, it, expect, vi } from 'vitest';
import type { SspStream } from '../../ssp/types';
import { SerializableStreamPart, isMutable } from '../../ssp/types';
import { ReasoningSSP } from '../../ssp/impl/reasoning';

function mockStream(opts?: { withThinking?: boolean }): SspStream {
  const stream: SspStream = {
    markdown: vi.fn(),
    progress: vi.fn(),
    push: vi.fn(),
  };
  if (opts?.withThinking !== false) {
    stream.thinkingProgress = vi.fn();
  }
  return stream;
}

describe('ReasoningSSP', () => {
  describe('construction', () => {
    it('should initialize with partId and delta as text', () => {
      const ssp = new ReasoningSSP({ partId: 'r1', delta: 'thinking...' });
      expect(ssp.kind).toBe('reasoning');
      expect(ssp.payload).toEqual({ partId: 'r1', text: 'thinking...', messageId: undefined });
    });
  });

  describe('render', () => {
    it('should call thinkingProgress with {text, id} when available', () => {
      const stream = mockStream();
      const ssp = new ReasoningSSP({ partId: 'r1', delta: 'thinking...' });
      ssp.render(stream);
      expect(stream.thinkingProgress).toHaveBeenCalledWith({ text: 'thinking...', id: 'r1' });
    });

    it('should silently skip when thinkingProgress is unavailable', () => {
      const stream = mockStream({ withThinking: false });
      const ssp = new ReasoningSSP({ partId: 'r1', delta: 'thinking...' });
      ssp.render(stream);
      // No error thrown, no markdown fallback
      expect(stream.markdown).not.toHaveBeenCalled();
    });
  });

  describe('append-only contract', () => {
    it('should NOT implement IMutableStreamPart', () => {
      const ssp = new ReasoningSSP({ partId: 'r1', delta: '' });
      expect(isMutable(ssp)).toBe(false);
    });
  });

  describe('toJSON', () => {
    it('should produce reasoning kind with correct payload', () => {
      const ssp = new ReasoningSSP({ partId: 'r1', delta: 'round-trip' });
      const json = ssp.toJSON();
      expect(json.kind).toBe('reasoning');
      expect(json.payload.text).toBe('round-trip');
    });
  });

  describe('instanceof', () => {
    it('should be instanceof SerializableStreamPart', () => {
      const ssp = new ReasoningSSP({ partId: 'r1', delta: '' });
      expect(ssp).toBeInstanceOf(SerializableStreamPart);
    });
  });
});
