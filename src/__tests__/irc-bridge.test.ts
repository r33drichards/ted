import { describe, it, expect } from 'vitest';
import {
  chunkForIrc,
  parseAdminCommand,
  normalizeRawLine,
  parseChannelList,
} from '../irc-bridge.js';

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

describe('parseAdminCommand', () => {
  it('parses verb and rest', () => {
    expect(parseAdminCommand(',join #a,#b')).toEqual({ verb: 'join', rest: '#a,#b' });
    expect(parseAdminCommand(',stop')).toEqual({ verb: 'stop', rest: '' });
    expect(parseAdminCommand(',send /join #chan')).toEqual({ verb: 'send', rest: '/join #chan' });
  });

  it('lowercases the verb', () => {
    expect(parseAdminCommand(',STOP')).toEqual({ verb: 'stop', rest: '' });
  });

  it('returns null for non-commands', () => {
    expect(parseAdminCommand('hello there')).toBeNull();
    expect(parseAdminCommand(',')).toBeNull();
    expect(parseAdminCommand(', ')).toBeNull();
    // A bare comma-space prose sentence should not match either
    expect(parseAdminCommand('well, that happened')).toBeNull();
  });
});

describe('normalizeRawLine', () => {
  it('passes raw lines through', () => {
    expect(normalizeRawLine('JOIN #chan')).toBe('JOIN #chan');
  });

  it('converts /slash form to a raw verb', () => {
    expect(normalizeRawLine('/join #chan')).toBe('JOIN #chan');
    expect(normalizeRawLine('/topic #chan :new topic')).toBe('TOPIC #chan :new topic');
  });
});

describe('parseChannelList', () => {
  it('splits on commas and spaces, keeps only channel names', () => {
    expect(parseChannelList('#a,#b #c')).toEqual(['#a', '#b', '#c']);
    expect(parseChannelList('nope #ok')).toEqual(['#ok']);
    expect(parseChannelList('')).toEqual([]);
  });
});
