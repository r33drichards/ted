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
} from './db.js';
import { subscribeDeltas } from './publish.js';

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

export type AppDeps = {
  signalWithStart: SignalWithStartFn;
  taskQueue: string;
  // Injectable DB helpers (tests override). Signatures mirror src/db.ts.
  getMessages?: typeof getMessages;
  getSessions?: typeof getSessions;
  createSession?: typeof createSession;
  sessionBelongsTo?: typeof sessionBelongsTo;
  renameSession?: typeof renameSession;
  subscribeDeltas?: typeof subscribeDeltas;
};

type Vars = { userId: string };

export function makeApp(deps: AppDeps) {
  const app = new Hono<{ Variables: Vars }>();
  const readMessages = deps.getMessages ?? getMessages;
  const readSessions = deps.getSessions ?? getSessions;
  const recordSession = deps.createSession ?? createSession;
  const ownsSession = deps.sessionBelongsTo ?? sessionBelongsTo;
  const updateSessionTitle = deps.renameSession ?? renameSession;
  const subscribe = deps.subscribeDeltas ?? subscribeDeltas;

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
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.title !== 'string') {
      return c.json({ error: 'title required' }, 400);
    }
    const ok = await updateSessionTitle(sessionId, userId, body.title);
    if (!ok) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
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
