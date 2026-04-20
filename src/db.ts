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
ALTER TABLE messages ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS messages_user_session_idx ON messages (user_id, session_id, id);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT        PRIMARY KEY,
  user_id     TEXT        NOT NULL,
  title       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id, updated_at DESC);
`;

export async function ensureSchema(): Promise<void> {
  await getPool().query(SCHEMA_SQL);
}

export async function appendMessage(
  sessionId: string,
  role: Role,
  content: string,
  userId: string,
): Promise<void> {
  await getPool().query(
    'INSERT INTO messages (session_id, role, content, user_id) VALUES ($1, $2, $3, $4)',
    [sessionId, role, content, userId],
  );
}

/**
 * Returns messages for `sessionId`, optionally scoped to `userId`.
 * When `userId` is undefined, no ownership check is applied — callers must
 * have already authorized the read. When provided, rows are returned only if
 * the session row's user_id matches.
 */
export async function getMessages(
  sessionId: string,
  userId?: string,
): Promise<Msg[]> {
  const sql = userId
    ? `SELECT m.role, m.content
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
        WHERE m.session_id = $1 AND s.user_id = $2
        ORDER BY m.id ASC`
    : `SELECT role, content FROM messages WHERE session_id = $1 ORDER BY id ASC`;
  const params = userId ? [sessionId, userId] : [sessionId];
  const { rows } = await getPool().query<{ role: Role; content: string }>(
    sql,
    params,
  );
  return rows.map((r) => ({ role: r.role, content: r.content }));
}

export type SessionRow = {
  id: string;
  title: string | null;
  updated_at: string;
};

export async function getSessions(userId: string): Promise<SessionRow[]> {
  const { rows } = await getPool().query<SessionRow>(
    `SELECT id, title, updated_at
       FROM sessions
      WHERE user_id = $1
      ORDER BY updated_at DESC`,
    [userId],
  );
  return rows;
}

/**
 * Idempotently record a new session for `userId`. No-op if a session with
 * this id already exists (even for a different user — callers should check
 * ownership via sessionBelongsTo before calling for existing ids).
 */
export async function createSession(
  userId: string,
  sessionId: string,
  title: string | null = null,
): Promise<void> {
  await getPool().query(
    `INSERT INTO sessions (id, user_id, title)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [sessionId, userId, title],
  );
}

export async function touchSession(sessionId: string): Promise<void> {
  await getPool().query(
    'UPDATE sessions SET updated_at = now() WHERE id = $1',
    [sessionId],
  );
}

export async function renameSession(
  sessionId: string,
  userId: string,
  title: string,
): Promise<boolean> {
  const res = await getPool().query(
    'UPDATE sessions SET title = $3, updated_at = now() WHERE id = $1 AND user_id = $2',
    [sessionId, userId, title],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function sessionBelongsTo(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const { rows } = await getPool().query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2) AS exists',
    [sessionId, userId],
  );
  return rows[0]?.exists ?? false;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
