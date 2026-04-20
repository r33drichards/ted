import { describe, it, expect } from 'vitest';
import { drainInbox } from '../inbox.js';
import type { Msg } from '../types.js';

describe('drainInbox', () => {
  it('returns null and leaves history unchanged when inbox is empty', () => {
    const history: Msg[] = [{ role: 'user', content: 'hi' }];
    const inbox: string[] = [];
    const result = drainInbox(inbox, history);
    expect(result).toBeNull();
    expect(history).toEqual([{ role: 'user', content: 'hi' }]);
    expect(inbox).toEqual([]);
  });

  it('appends a new user turn when last message is assistant', () => {
    const history: Msg[] = [{ role: 'assistant', content: 'hello' }];
    const inbox: string[] = ['first', 'second'];
    const result = drainInbox(inbox, history);
    expect(result).toBe('first\n\nsecond');
    expect(history).toEqual([
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'first\n\nsecond' },
    ]);
    expect(inbox).toEqual([]);
  });

  it('appends a new user turn when history is empty', () => {
    const history: Msg[] = [];
    const inbox: string[] = ['only message'];
    const result = drainInbox(inbox, history);
    expect(result).toBe('only message');
    expect(history).toEqual([{ role: 'user', content: 'only message' }]);
  });
});
