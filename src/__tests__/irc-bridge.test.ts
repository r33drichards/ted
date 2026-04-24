import { describe, it, expect } from 'vitest';
import { chunkForIrc } from '../irc-bridge.js';

describe('chunkForIrc', () => {
  it('collapses newlines and whitespace', () => {
    expect(chunkForIrc('hello\nworld\r\n\n  there')).toEqual(['hello world there']);
  });

  it('returns [] for empty/whitespace-only input', () => {
    expect(chunkForIrc('   \n\n ')).toEqual([]);
  });

  it('splits on word boundaries when over byte limit', () => {
    const text = 'aa bb cc dd ee ff';
    const chunks = chunkForIrc(text, 5);
    expect(chunks).toEqual(['aa bb', 'cc dd', 'ee ff']);
    for (const c of chunks) expect(Buffer.byteLength(c)).toBeLessThanOrEqual(5);
  });

  it('hard-splits a word that exceeds max on its own', () => {
    const chunks = chunkForIrc('xxxxxxxxxx', 4);
    expect(chunks).toEqual(['xxxx', 'xxxx', 'xx']);
  });
});
