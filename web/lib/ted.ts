import { env } from './env';

/** Fetch helper that injects the X-User-ID header ted's middleware requires. */
export async function tedFetch(
  userId: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('X-User-ID', userId);
  return fetch(`${env.tedUrl}${path}`, { ...init, headers });
}

export type Msg = { role: 'user' | 'assistant'; content: string };

export async function listSessions(userId: string): Promise<
  Array<{ id: string; title: string | null; updated_at: string }>
> {
  const res = await tedFetch(userId, '/sessions');
  if (!res.ok) throw new Error(`ted /sessions ${res.status}`);
  const data = (await res.json()) as {
    sessions: Array<{ id: string; title: string | null; updated_at: string }>;
  };
  return data.sessions;
}

export async function getSessionMessages(
  userId: string,
  sessionId: string,
): Promise<Msg[]> {
  const res = await tedFetch(userId, `/sessions/${encodeURIComponent(sessionId)}/messages`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`ted /messages ${res.status}`);
  const data = (await res.json()) as { messages: Msg[] };
  return data.messages;
}

export async function postMessage(
  userId: string,
  sessionId: string,
  msg: string,
): Promise<void> {
  const res = await tedFetch(userId, '/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, msg }),
  });
  if (!res.ok) throw new Error(`ted /message ${res.status}: ${await res.text()}`);
}

export async function renameSession(
  userId: string,
  sessionId: string,
  title: string,
): Promise<void> {
  const res = await tedFetch(userId, `/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`ted /sessions PATCH ${res.status}`);
}

export async function setArchived(
  userId: string,
  sessionId: string,
  archived: boolean,
): Promise<void> {
  const res = await tedFetch(userId, `/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ archived }),
  });
  if (!res.ok) throw new Error(`ted /sessions PATCH ${res.status}`);
}

export async function deleteSession(
  userId: string,
  sessionId: string,
): Promise<void> {
  const res = await tedFetch(userId, `/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`ted /sessions DELETE ${res.status}`);
  }
}

export type McpServer = {
  id: string;
  user_id: string;
  name: string;
  url: string;
  allowed_tools: string[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type McpServerInput = {
  name: string;
  url: string;
  allowed_tools?: string[];
  enabled?: boolean;
};

export type McpServerPatch = Partial<McpServerInput>;

export async function listMcpServers(userId: string): Promise<McpServer[]> {
  const res = await tedFetch(userId, '/mcp/servers');
  if (!res.ok) throw new Error(`ted /mcp/servers ${res.status}`);
  const data = (await res.json()) as { servers: McpServer[] };
  return data.servers;
}

export async function createMcpServer(
  userId: string,
  body: McpServerInput,
): Promise<McpServer> {
  const res = await tedFetch(userId, '/mcp/servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ted POST /mcp/servers ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { server: McpServer };
  return data.server;
}

export async function updateMcpServer(
  userId: string,
  id: string,
  patch: McpServerPatch,
): Promise<McpServer> {
  const res = await tedFetch(userId, `/mcp/servers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`ted PATCH /mcp/servers ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { server: McpServer };
  return data.server;
}

export async function deleteMcpServer(userId: string, id: string): Promise<void> {
  const res = await tedFetch(userId, `/mcp/servers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`ted DELETE /mcp/servers ${res.status}`);
}

export type ScheduledPrompt = {
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

export type ScheduledPromptInput = {
  name: string;
  prompt: string;
  session_id: string;
  interval_seconds: number;
  enabled?: boolean;
};

export type ScheduledPromptPatch = Partial<ScheduledPromptInput>;

export async function listScheduledPrompts(
  userId: string,
): Promise<ScheduledPrompt[]> {
  const res = await tedFetch(userId, '/scheduled-prompts');
  if (!res.ok) throw new Error(`ted /scheduled-prompts ${res.status}`);
  const data = (await res.json()) as { prompts: ScheduledPrompt[] };
  return data.prompts;
}

/**
 * Open ted's SSE stream for a session. Returns the response so the caller
 * can pipe the body through to the browser.
 */
export async function openStream(
  userId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<Response> {
  return tedFetch(userId, `/sessions/${encodeURIComponent(sessionId)}/stream`, {
    headers: { accept: 'text/event-stream' },
    signal,
  });
}
