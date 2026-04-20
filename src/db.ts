import pg from 'pg';
import type { Msg, Role } from './types.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString =
    process.env.DATABASE_URL ?? 'postgres://localhost:5432/chat';
  pool = new Pool({ connectionString });
  return pool;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  id          BIGSERIAL PRIMARY KEY,
  session_id  TEXT        NOT NULL,
  role        TEXT        NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_session_id_idx ON messages (session_id, id);
`;

export async function ensureSchema(): Promise<void> {
  await getPool().query(SCHEMA_SQL);
}

export async function appendMessage(
  sessionId: string,
  role: Role,
  content: string,
): Promise<void> {
  await getPool().query(
    'INSERT INTO messages (session_id, role, content) VALUES ($1, $2, $3)',
    [sessionId, role, content],
  );
}

export async function getMessages(sessionId: string): Promise<Msg[]> {
  const { rows } = await getPool().query<{ role: Role; content: string }>(
    'SELECT role, content FROM messages WHERE session_id = $1 ORDER BY id ASC',
    [sessionId],
  );
  return rows.map((r) => ({ role: r.role, content: r.content }));
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
