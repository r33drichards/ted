import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { Client, Connection } from '@temporalio/client';
import { chatSession } from './workflows.js';
import { userMessageSignal } from './signals.js';
import {
  ensureSchema,
  getMessages,
  getSessions,
  createSession,
  sessionBelongsTo,
  renameSession,
  setSessionArchived,
  deleteSession,
  listMcpServers,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  McpNameTakenError,
} from './db.js';
import { subscribeDeltas } from './publish.js';
import { closeSignal } from './signals.js';
import * as mcp from './mcp-client.js';

export type SignalWithStartFn = (
  workflow: typeof chatSession,
  options: {
    workflowId: string;
    taskQueue: string;
    args: [string, ...unknown[]];
    signal: typeof userMessageSignal;
    signalArgs: [string];
  },
) => Promise<{ workflowId: string }>;

export type SignalCloseFn = (workflowId: string) => Promise<void>;

export type AppDeps = {
  signalWithStart: SignalWithStartFn;
  taskQueue: string;
  // Injectable DB helpers (tests override). Signatures mirror src/db.ts.
  getMessages?: typeof getMessages;
  getSessions?: typeof getSessions;
  createSession?: typeof createSession;
  sessionBelongsTo?: typeof sessionBelongsTo;
  renameSession?: typeof renameSession;
  setSessionArchived?: typeof setSessionArchived;
  deleteSession?: typeof deleteSession;
  subscribeDeltas?: typeof subscribeDeltas;
  listMcpServers?: typeof listMcpServers;
  createMcpServer?: typeof createMcpServer;
  updateMcpServer?: typeof updateMcpServer;
  deleteMcpServer?: typeof deleteMcpServer;
  // Close the running workflow for this session. Best-effort — if the
  // workflow isn't running this is a no-op.
  signalClose?: SignalCloseFn;
};

type Vars = { userId: string };

type McpValidateOpts = { requireName?: boolean; requireUrl?: boolean };

function validateMcpBody(body: unknown, opts: McpValidateOpts): string | null {
  if (!body || typeof body !== 'object') return 'invalid body';
  const b = body as Record<string, unknown>;
  if (opts.requireName && typeof b.name !== 'string') return 'name required';
  if (b.name !== undefined) {
    if (typeof b.name !== 'string' || !b.name || b.name.length > 128) {
      return 'name must be a non-empty string up to 128 chars';
    }
  }
  if (opts.requireUrl && typeof b.url !== 'string') return 'url required';
  if (b.url !== undefined) {
    if (typeof b.url !== 'string') return 'url must be a string';
    let parsed: URL;
    try {
      parsed = new URL(b.url);
    } catch {
      return 'url is not a valid URL';
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return 'url must be http or https';
    }
  }
  if (b.allowed_tools !== undefined) {
    if (
      !Array.isArray(b.allowed_tools) ||
      !b.allowed_tools.every((t) => typeof t === 'string')
    ) {
      return 'allowed_tools must be an array of strings';
    }
  }
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') {
    return 'enabled must be a boolean';
  }
  return null;
}

export function makeApp(deps: AppDeps) {
  const app = new Hono<{ Variables: Vars }>();
  const readMessages = deps.getMessages ?? getMessages;
  const readSessions = deps.getSessions ?? getSessions;
  const recordSession = deps.createSession ?? createSession;
  const ownsSession = deps.sessionBelongsTo ?? sessionBelongsTo;
  const updateSessionTitle = deps.renameSession ?? renameSession;
  const updateSessionArchived = deps.setSessionArchived ?? setSessionArchived;
  const dropSession = deps.deleteSession ?? deleteSession;
  const closeWorkflow: SignalCloseFn =
    deps.signalClose ?? (async () => undefined);
  const subscribe = deps.subscribeDeltas ?? subscribeDeltas;
  const mcpList = deps.listMcpServers ?? listMcpServers;
  const mcpCreate = deps.createMcpServer ?? createMcpServer;
  const mcpUpdate = deps.updateMcpServer ?? updateMcpServer;
  const mcpDelete = deps.deleteMcpServer ?? deleteMcpServer;

  // Auth middleware: require X-User-ID. Ted trusts the Next.js BFF on
  // localhost to set this header after verifying a Keycloak session.
  app.use('*', async (c, next) => {
    const userId = c.req.header('X-User-ID');
    if (!userId) {
      return c.json({ error: 'X-User-ID required' }, 401);
    }
    c.set('userId', userId);
    await next();
  });

  app.post('/message', async (c) => {
    const userId = c.get('userId');
    const body = await c.req.json().catch(() => null);
    if (
      !body ||
      typeof body.sessionId !== 'string' ||
      typeof body.msg !== 'string' ||
      !body.sessionId ||
      !body.msg
    ) {
      return c.json({ error: 'sessionId and msg required' }, 400);
    }

    // If the session row already exists under a different user, reject.
    const exists = await ownsSession(body.sessionId, userId);
    if (!exists) {
      // First message for this session — record ownership. If another user
      // already owns this id, the INSERT is a no-op and the next ownsSession
      // check fails.
      await recordSession(userId, body.sessionId, null);
      const nowOwned = await ownsSession(body.sessionId, userId);
      if (!nowOwned) {
        return c.json({ error: 'session belongs to another user' }, 403);
      }
    }

    const handle = await deps.signalWithStart(chatSession, {
      workflowId: `chat:${body.sessionId}`,
      taskQueue: deps.taskQueue,
      args: [body.sessionId, [], userId],
      signal: userMessageSignal,
      signalArgs: [body.msg],
    });

    return c.json({ ok: true, workflowId: handle.workflowId });
  });

  app.get('/sessions', async (c) => {
    const userId = c.get('userId');
    const sessions = await readSessions(userId);
    return c.json({ sessions });
  });

  app.get('/sessions/:sessionId/messages', async (c) => {
    const userId = c.get('userId');
    const sessionId = c.req.param('sessionId');
    if (!(await ownsSession(sessionId, userId))) {
      return c.json({ error: 'not found' }, 404);
    }
    const messages = await readMessages(sessionId, userId);
    return c.json({ sessionId, messages });
  });

  app.patch('/sessions/:sessionId', async (c) => {
    const userId = c.get('userId');
    const sessionId = c.req.param('sessionId');
    const body = (await c.req.json().catch(() => null)) as
      | { title?: unknown; archived?: unknown }
      | null;
    if (!body) return c.json({ error: 'invalid body' }, 400);

    const hasTitle = typeof body.title === 'string';
    const hasArchived = typeof body.archived === 'boolean';
    if (!hasTitle && !hasArchived) {
      return c.json({ error: 'title or archived required' }, 400);
    }

    if (hasTitle) {
      const ok = await updateSessionTitle(sessionId, userId, body.title as string);
      if (!ok) return c.json({ error: 'not found' }, 404);
    }
    if (hasArchived) {
      const ok = await updateSessionArchived(
        sessionId,
        userId,
        body.archived as boolean,
      );
      if (!ok) return c.json({ error: 'not found' }, 404);
    }
    return c.json({ ok: true });
  });

  app.delete('/sessions/:sessionId', async (c) => {
    const userId = c.get('userId');
    const sessionId = c.req.param('sessionId');
    if (!(await ownsSession(sessionId, userId))) {
      return c.json({ error: 'not found' }, 404);
    }
    // Best-effort: tell the workflow (if any) to exit. Swallow errors — the
    // workflow may have already completed or never existed.
    try {
      await closeWorkflow(`chat:${sessionId}`);
    } catch {
      /* ignore */
    }
    const ok = await dropSession(sessionId, userId);
    if (!ok) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  app.get('/mcp/servers', async (c) => {
    const userId = c.get('userId');
    const servers = await mcpList(userId);
    return c.json({ servers });
  });

  app.post('/mcp/servers', async (c) => {
    const userId = c.get('userId');
    const body = await c.req.json().catch(() => null);
    const err = validateMcpBody(body, { requireName: true, requireUrl: true });
    if (err) return c.json({ error: err }, 400);
    try {
      const row = await mcpCreate(userId, {
        name: body.name,
        url: body.url,
        allowed_tools: body.allowed_tools,
        enabled: body.enabled,
      });
      return c.json({ server: row }, 201);
    } catch (e) {
      if (e instanceof McpNameTakenError) {
        return c.json({ error: 'name already exists' }, 409);
      }
      throw e;
    }
  });

  app.patch('/mcp/servers/:id', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const err = validateMcpBody(body, {});
    if (err) return c.json({ error: err }, 400);
    try {
      const row = await mcpUpdate(id, userId, {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.url !== undefined && { url: body.url }),
        ...(body.allowed_tools !== undefined && {
          allowed_tools: body.allowed_tools,
        }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
      });
      if (!row) return c.json({ error: 'not found' }, 404);
      return c.json({ server: row });
    } catch (e) {
      if (e instanceof McpNameTakenError) {
        return c.json({ error: 'name already exists' }, 409);
      }
      throw e;
    }
  });

  app.delete('/mcp/servers/:id', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');
    const ok = await mcpDelete(id, userId);
    if (!ok) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  app.get('/mcp/servers/:id/health', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');
    const rows = await mcpList(userId);
    const row = rows.find((r) => r.id === id);
    if (!row) return c.json({ error: 'not found' }, 404);
    try {
      const tools = await mcp.listTools(row.url);
      return c.json({
        connected: true,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description ?? null,
        })),
      });
    } catch (err) {
      return c.json({
        connected: false,
        tools: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/sessions/:sessionId/stream', async (c) => {
    const userId = c.get('userId');
    const sessionId = c.req.param('sessionId');
    if (!(await ownsSession(sessionId, userId))) {
      return c.json({ error: 'not found' }, 404);
    }
    const lastEventId = c.req.header('Last-Event-ID');
    const fromQuery = c.req.query('from');
    const from = lastEventId ?? fromQuery ?? '$';

    return streamSSE(c, async (sse) => {
      const abort = new AbortController();
      const onClose = () => abort.abort();
      c.req.raw.signal?.addEventListener('abort', onClose);

      try {
        for await (const { id, event } of subscribe(sessionId, from, abort.signal)) {
          await sse.writeSSE({ id, data: JSON.stringify(event) });
          if (event.type === 'turn_end') {
            // leave the connection open; more turns may arrive on the same session
          }
        }
      } finally {
        c.req.raw.signal?.removeEventListener('abort', onClose);
        abort.abort();
      }
    });
  });

  return app;
}

async function main() {
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
  const taskQueue = process.env.TASK_QUEUE ?? 'chat';
  const port = Number(process.env.WEBHOOK_PORT ?? 8787);

  await ensureSchema();

  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  const app = makeApp({
    // `as any` here bridges Hono-world typing to the Temporal client's
    // generic signalWithStart — the test uses a narrower mock signature.
    signalWithStart: (wf, opts) => client.workflow.signalWithStart(wf, opts as any) as any,
    taskQueue,
    signalClose: async (workflowId) => {
      try {
        await client.workflow.getHandle(workflowId).signal(closeSignal);
      } catch {
        /* workflow may be absent or already done; best-effort */
      }
    },
  });

  console.log(`Webhook listening on :${port}`);
  serve({ fetch: app.fetch, port });
}

// Only run if invoked as entry point.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
