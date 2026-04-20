import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ioredis-mock can stand in for both the singleton and the subscribe-side
// connection. Aliasing `ioredis` to `ioredis-mock` covers both `new Redis(...)`
// call sites in src without patching them individually.
vi.mock('ioredis', async () => {
  const mod = await import('ioredis-mock');
  return { default: mod.default, Redis: mod.default };
});

import { publishDelta, publishTurnEnd, subscribeDeltas } from '../publish.js';
import { getRedis, closeRedis } from '../redis.js';

describe('publish', () => {
  beforeEach(async () => {
    const r = getRedis();
    await r.flushall();
  });

  afterEach(async () => {
    await closeRedis();
  });

  it('publishDelta writes a delta entry to the session stream', async () => {
    await publishDelta('s1', 'hello');
    const entries = await getRedis().xrange('session:s1:deltas', '-', '+');
    expect(entries.length).toBe(1);
    const [, fields] = entries[0];
    const idx = fields.indexOf('data');
    expect(JSON.parse(fields[idx + 1])).toEqual({ type: 'delta', text: 'hello' });
  });

  it('publishTurnEnd writes a turn_end sentinel', async () => {
    await publishTurnEnd('s1');
    const entries = await getRedis().xrange('session:s1:deltas', '-', '+');
    expect(entries.length).toBe(1);
    const [, fields] = entries[0];
    const idx = fields.indexOf('data');
    expect(JSON.parse(fields[idx + 1])).toEqual({ type: 'turn_end' });
  });

  it('subscribeDeltas replays prior entries from "0"', async () => {
    await publishDelta('s2', 'a');
    await publishDelta('s2', 'b');
    await publishTurnEnd('s2');

    const abort = new AbortController();
    const seen: string[] = [];
    const iter = subscribeDeltas('s2', '0', abort.signal);
    for await (const { event } of iter) {
      if (event.type === 'delta') seen.push(event.text);
      if (event.type === 'turn_end') {
        abort.abort();
        break;
      }
    }
    expect(seen).toEqual(['a', 'b']);
  });
});
