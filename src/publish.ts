import type { Redis as RedisClient } from 'ioredis';
import Redis from 'ioredis';
import { getRedis } from './redis.js';

const STREAM_MAXLEN = 5000;

function streamKey(sessionId: string): string {
  return `session:${sessionId}:deltas`;
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'turn_end' };

/**
 * Publish a streaming text delta for a session. Writes to a Redis Stream
 * keyed by session id, trimmed to ~STREAM_MAXLEN entries so it can't grow
 * unbounded. Subscribers replay from any stream id via `subscribeDeltas`.
 */
export async function publishDelta(sessionId: string, text: string): Promise<void> {
  const r = getRedis();
  const event: StreamEvent = { type: 'delta', text };
  await r.xadd(
    streamKey(sessionId),
    'MAXLEN',
    '~',
    String(STREAM_MAXLEN),
    '*',
    'data',
    JSON.stringify(event),
  );
}

/** Sentinel marking the end of an assistant turn. */
export async function publishTurnEnd(sessionId: string): Promise<void> {
  const r = getRedis();
  const event: StreamEvent = { type: 'turn_end' };
  await r.xadd(
    streamKey(sessionId),
    'MAXLEN',
    '~',
    String(STREAM_MAXLEN),
    '*',
    'data',
    JSON.stringify(event),
  );
}

export type StreamEntry = { id: string; event: StreamEvent };

/**
 * Async-iterable subscription to a session's deltas. Uses XREAD BLOCK on a
 * dedicated connection (blocking commands can't share the singleton client).
 *
 * `from` is a Redis stream id: `'0'` replays from the beginning, `'$'` is
 * live-only, or any previously-seen id to resume. Iteration ends when the
 * supplied AbortSignal fires.
 */
export async function* subscribeDeltas(
  sessionId: string,
  from: string,
  signal: AbortSignal,
): AsyncIterable<StreamEntry> {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const conn: RedisClient = new Redis(url, { maxRetriesPerRequest: null });
  const onAbort = () => {
    conn.disconnect();
  };
  signal.addEventListener('abort', onAbort);

  let cursor = from;
  try {
    while (!signal.aborted) {
      let reply: [string, [string, string[]][]][] | null = null;
      try {
        reply = (await conn.xread(
          'BLOCK',
          5000,
          'STREAMS',
          streamKey(sessionId),
          cursor,
        )) as [string, [string, string[]][]][] | null;
      } catch (err) {
        if (signal.aborted) return;
        throw err;
      }
      if (!reply) continue;

      for (const [, entries] of reply) {
        for (const [id, fields] of entries) {
          cursor = id;
          const dataIdx = fields.indexOf('data');
          if (dataIdx < 0) continue;
          const raw = fields[dataIdx + 1];
          let event: StreamEvent;
          try {
            event = JSON.parse(raw) as StreamEvent;
          } catch {
            continue;
          }
          yield { id, event };
        }
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    try {
      await conn.quit();
    } catch {
      // ignore
    }
  }
}
