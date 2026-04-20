import Redis, { type Redis as RedisClient } from 'ioredis';

let client: RedisClient | null = null;

export function getRedis(): RedisClient {
  if (client) return client;
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  client = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
  return client;
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  await client.quit();
  client = null;
}
