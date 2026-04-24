import { describe, it, expect } from 'vitest';
import { parseIrcLine, nickFromPrefix, chunkForIrc } from '../irc-bridge.js';

describe('parseIrcLine', () => {
  it('parses a PRIVMSG with prefix and trailing', () => {
    const m = parseIrcLine(':alice!~a@host PRIVMSG #chan :hello world');
    expect(m).toEqual({
      prefix: 'alice!~a@host',
      command: 'PRIVMSG',
      params: ['#chan', 'hello world'],
    });
  });

  it('uppercases the command', () => {
    expect(parseIrcLine('ping :srv')?.command).toBe('PING');
  });

  it('parses a command without prefix', () => {
    expect(parseIrcLine('PING :server.tld')).toEqual({
      prefix: undefined,
      command: 'PING',
      params: ['server.tld'],
    });
  });

  it('preserves spaces in the trailing parameter', () => {
    const m = parseIrcLine(':x PRIVMSG #c :a  b   c');
    expect(m?.params[1]).toBe('a  b   c');
  });

  it('handles multiple middle params before trailing', () => {
    const m = parseIrcLine(':srv 353 bot = #c :alice bob carol');
    expect(m).toEqual({
      prefix: 'srv',
      command: '353',
      params: ['bot', '=', '#c', 'alice bob carol'],
    });
  });

  it('returns null for empty input', () => {
    expect(parseIrcLine('')).toBeNull();
  });
});

describe('nickFromPrefix', () => {
  it('extracts nick before !', () => {
    expect(nickFromPrefix('alice!~a@host')).toBe('alice');
  });
  it('returns the prefix when no ! present (servername)', () => {
    expect(nickFromPrefix('irc.server.tld')).toBe('irc.server.tld');
  });
  it('returns null for undefined', () => {
    expect(nickFromPrefix(undefined)).toBeNull();
  });
});

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
