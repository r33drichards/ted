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
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

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
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS sessions_user_active_idx ON sessions (user_id, archived, updated_at DESC);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        TEXT        NOT NULL,
  name           TEXT        NOT NULL,
  url            TEXT        NOT NULL,
  allowed_tools  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  enabled        BOOLEAN     NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS mcp_servers_user_enabled_idx
  ON mcp_servers (user_id) WHERE enabled;

CREATE TABLE IF NOT EXISTS scheduled_prompts (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           TEXT        NOT NULL,
  name              TEXT        NOT NULL,
  prompt            TEXT        NOT NULL,
  session_id        TEXT        NOT NULL,
  interval_seconds  INTEGER     NOT NULL CHECK (interval_seconds >= 60),
  enabled           BOOLEAN     NOT NULL DEFAULT true,
  last_run_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS scheduled_prompts_user_idx
  ON scheduled_prompts (user_id, created_at DESC);
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

export async function getSessions(
  userId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<SessionRow[]> {
  const sql = opts.includeArchived
    ? `SELECT id, title, updated_at
         FROM sessions
        WHERE user_id = $1
        ORDER BY updated_at DESC`
    : `SELECT id, title, updated_at
         FROM sessions
        WHERE user_id = $1 AND archived = FALSE
        ORDER BY updated_at DESC`;
  const { rows } = await getPool().query<SessionRow>(sql, [userId]);
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

export async function setSessionArchived(
  sessionId: string,
  userId: string,
  archived: boolean,
): Promise<boolean> {
  const res = await getPool().query(
    'UPDATE sessions SET archived = $3, updated_at = now() WHERE id = $1 AND user_id = $2',
    [sessionId, userId, archived],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Hard-delete a session + its messages. Transactional — either both rows
 * go or nothing. Returns true iff the session existed and was owned by
 * the caller.
 */
export async function deleteSession(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const pool = getPool();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const owns = await c.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2) AS exists',
      [sessionId, userId],
    );
    if (!owns.rows[0]?.exists) {
      await c.query('ROLLBACK');
      return false;
    }
    await c.query('DELETE FROM messages WHERE session_id = $1', [sessionId]);
    await c.query('DELETE FROM sessions WHERE id = $1 AND user_id = $2', [
      sessionId,
      userId,
    ]);
    await c.query('COMMIT');
    return true;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
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

export type McpServerRow = {
  id: string;
  user_id: string;
  name: string;
  url: string;
  allowed_tools: string[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export class McpNameTakenError extends Error {
  constructor(name: string) {
    super(`mcp server name already exists: ${name}`);
    this.name = 'McpNameTakenError';
  }
}

const MCP_COLS =
  'id, user_id, name, url, allowed_tools, enabled, created_at, updated_at';

export async function listMcpServers(userId: string): Promise<McpServerRow[]> {
  const { rows } = await getPool().query<McpServerRow>(
    `SELECT ${MCP_COLS} FROM mcp_servers
      WHERE user_id = $1
      ORDER BY created_at ASC`,
    [userId],
  );
  return rows;
}

export async function listEnabledMcpServers(
  userId: string,
): Promise<McpServerRow[]> {
  const { rows } = await getPool().query<McpServerRow>(
    `SELECT ${MCP_COLS} FROM mcp_servers
      WHERE user_id = $1 AND enabled
      ORDER BY created_at ASC`,
    [userId],
  );
  return rows;
}

export type CreateMcpServerInput = {
  name: string;
  url: string;
  allowed_tools?: string[];
  enabled?: boolean;
};

export async function createMcpServer(
  userId: string,
  input: CreateMcpServerInput,
): Promise<McpServerRow> {
  try {
    const { rows } = await getPool().query<McpServerRow>(
      `INSERT INTO mcp_servers (user_id, name, url, allowed_tools, enabled)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING ${MCP_COLS}`,
      [
        userId,
        input.name,
        input.url,
        JSON.stringify(input.allowed_tools ?? []),
        input.enabled ?? true,
      ],
    );
    return rows[0]!;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new McpNameTakenError(input.name);
    }
    throw err;
  }
}

export type UpdateMcpServerPatch = Partial<{
  name: string;
  url: string;
  allowed_tools: string[];
  enabled: boolean;
}>;

export async function updateMcpServer(
  id: string,
  userId: string,
  patch: UpdateMcpServerPatch,
): Promise<McpServerRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    params.push(patch.name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.url !== undefined) {
    params.push(patch.url);
    sets.push(`url = $${params.length}`);
  }
  if (patch.allowed_tools !== undefined) {
    params.push(JSON.stringify(patch.allowed_tools));
    sets.push(`allowed_tools = $${params.length}::jsonb`);
  }
  if (patch.enabled !== undefined) {
    params.push(patch.enabled);
    sets.push(`enabled = $${params.length}`);
  }
  if (sets.length === 0) {
    const { rows } = await getPool().query<McpServerRow>(
      `SELECT ${MCP_COLS} FROM mcp_servers WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return rows[0] ?? null;
  }
  sets.push(`updated_at = now()`);
  params.push(id, userId);
  const idIdx = params.length - 1;
  const userIdx = params.length;
  try {
    const { rows } = await getPool().query<McpServerRow>(
      `UPDATE mcp_servers SET ${sets.join(', ')}
        WHERE id = $${idIdx} AND user_id = $${userIdx}
        RETURNING ${MCP_COLS}`,
      params,
    );
    return rows[0] ?? null;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new McpNameTakenError(patch.name ?? '');
    }
    throw err;
  }
}

export async function deleteMcpServer(
  id: string,
  userId: string,
): Promise<boolean> {
  const res = await getPool().query(
    'DELETE FROM mcp_servers WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return (res.rowCount ?? 0) > 0;
}

export type ScheduledPromptRow = {
  id: string;
  user_id: string;
  name: string;
  prompt: string;
  session_id: string;
  interval_seconds: number;
  enabled: boolean;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
};

export class ScheduledPromptNameTakenError extends Error {
  constructor(name: string) {
    super(`scheduled prompt name already exists: ${name}`);
    this.name = 'ScheduledPromptNameTakenError';
  }
}

const SCHEDULED_PROMPT_COLS =
  'id, user_id, name, prompt, session_id, interval_seconds, enabled, last_run_at, created_at, updated_at';

export async function listScheduledPrompts(
  userId: string,
): Promise<ScheduledPromptRow[]> {
  const { rows } = await getPool().query<ScheduledPromptRow>(
    `SELECT ${SCHEDULED_PROMPT_COLS} FROM scheduled_prompts
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

export async function getScheduledPrompt(
  id: string,
  userId: string,
): Promise<ScheduledPromptRow | null> {
  const { rows } = await getPool().query<ScheduledPromptRow>(
    `SELECT ${SCHEDULED_PROMPT_COLS} FROM scheduled_prompts
      WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] ?? null;
}

export type CreateScheduledPromptInput = {
  name: string;
  prompt: string;
  session_id: string;
  interval_seconds: number;
  enabled?: boolean;
};

export async function createScheduledPrompt(
  userId: string,
  input: CreateScheduledPromptInput,
): Promise<ScheduledPromptRow> {
  try {
    const { rows } = await getPool().query<ScheduledPromptRow>(
      `INSERT INTO scheduled_prompts
         (user_id, name, prompt, session_id, interval_seconds, enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${SCHEDULED_PROMPT_COLS}`,
      [
        userId,
        input.name,
        input.prompt,
        input.session_id,
        input.interval_seconds,
        input.enabled ?? true,
      ],
    );
    return rows[0]!;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new ScheduledPromptNameTakenError(input.name);
    }
    throw err;
  }
}

export type UpdateScheduledPromptPatch = Partial<{
  name: string;
  prompt: string;
  session_id: string;
  interval_seconds: number;
  enabled: boolean;
}>;

export async function updateScheduledPrompt(
  id: string,
  userId: string,
  patch: UpdateScheduledPromptPatch,
): Promise<ScheduledPromptRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    params.push(patch.name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.prompt !== undefined) {
    params.push(patch.prompt);
    sets.push(`prompt = $${params.length}`);
  }
  if (patch.session_id !== undefined) {
    params.push(patch.session_id);
    sets.push(`session_id = $${params.length}`);
  }
  if (patch.interval_seconds !== undefined) {
    params.push(patch.interval_seconds);
    sets.push(`interval_seconds = $${params.length}`);
  }
  if (patch.enabled !== undefined) {
    params.push(patch.enabled);
    sets.push(`enabled = $${params.length}`);
  }
  if (sets.length === 0) {
    return getScheduledPrompt(id, userId);
  }
  sets.push(`updated_at = now()`);
  params.push(id, userId);
  const idIdx = params.length - 1;
  const userIdx = params.length;
  try {
    const { rows } = await getPool().query<ScheduledPromptRow>(
      `UPDATE scheduled_prompts SET ${sets.join(', ')}
        WHERE id = $${idIdx} AND user_id = $${userIdx}
        RETURNING ${SCHEDULED_PROMPT_COLS}`,
      params,
    );
    return rows[0] ?? null;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new ScheduledPromptNameTakenError(patch.name ?? '');
    }
    throw err;
  }
}

export async function markScheduledPromptRan(
  id: string,
  userId: string,
): Promise<void> {
  await getPool().query(
    'UPDATE scheduled_prompts SET last_run_at = now() WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
}

export async function deleteScheduledPrompt(
  id: string,
  userId: string,
): Promise<boolean> {
  const res = await getPool().query(
    'DELETE FROM scheduled_prompts WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return (res.rowCount ?? 0) > 0;
}
