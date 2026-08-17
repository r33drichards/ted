import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { Client, Connection } from '@temporalio/client';
import { chatSession } from './workflows.js';
import { userMessageSignal, closeSignal, experimentSteerSignal } from './signals.js';
import {
  ensureSchema,
  getExperimentBySession,
  getMessages,
  getSessions,
  createSession,
  sessionBelongsTo,
  renameSession,
  setSessionArchived,
  deleteSession,
} from './db.js';
import { subscribeDeltas } from './publish.js';

type Vars = { userId: string };

// Workflow ID prefix. Bumped from `chat:` when the agent loop moved into
// the workflow (per-tool-call activities) — a workflow-shape change that
// old running histories can't replay.
export const WF_PREFIX = 'chat2:';
const LEGACY_WF_PREFIX = 'chat:';

export function makeApp(deps: {
  signalWithStart: (wf: typeof chatSession, opts: any) => Promise<any>;
  taskQueue: string;
  signalClose?: (workflowId: string) => Promise<void>;
  terminateLegacy?: (workflowId: string) => Promise<void>;
  /** Route a message to an active experiment for this session. Returns true if handled. */
  steerExperiment?: (sessionId: string, msg: string) => Promise<boolean>;
}) {
  const app = new Hono<{ Variables: Vars }>();
  const legacyCleaned = new Set<string>();

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

    const exists = await sessionBelongsTo(body.sessionId, userId);
    if (!exists) {
      await createSession(userId, body.sessionId);
      const nowOwned = await sessionBelongsTo(body.sessionId, userId);
      if (!nowOwned) {
        return c.json({ error: 'session belongs to another user' }, 403);
      }
    }

    // Messages in an active experiment's channel steer the experiment
    // workflow instead of the channel's chat session.
    if (await deps.steerExperiment?.(body.sessionId, body.msg)) {
      return c.json({ ok: true, routed: 'experiment' });
    }

    // Best-effort: terminate the pre-refactor workflow for this session once.
    if (!legacyCleaned.has(body.sessionId)) {
      legacyCleaned.add(body.sessionId);
      deps.terminateLegacy?.(`${LEGACY_WF_PREFIX}${body.sessionId}`).catch(() => {});
    }

    await deps.signalWithStart(chatSession, {
      workflowId: `${WF_PREFIX}${body.sessionId}`,
      taskQueue: deps.taskQueue,
      args: [body.sessionId, [], userId],
      signal: userMessageSignal,
      signalArgs: [body.msg],
    });

    return c.json({ ok: true });
  });

  app.get('/sessions', async (c) => {
    const userId = c.get('userId');
    const sessions = await getSessions(userId);
    return c.json({ sessions });
  });

  app.get('/sessions/:sessionId/messages', async (c) => {
    const userId = c.get('userId');
    const sessionId = c.req.param('sessionId');
    if (!(await sessionBelongsTo(sessionId, userId))) {
      return c.json({ error: 'not found' }, 404);
    }
    const messages = await getMessages(sessionId, userId);
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
      const ok = await renameSession(sessionId, userId, body.title as string);
      if (!ok) return c.json({ error: 'not found' }, 404);
    }
    if (hasArchived) {
      const ok = await setSessionArchived(sessionId, userId, body.archived as boolean);
      if (!ok) return c.json({ error: 'not found' }, 404);
    }
    return c.json({ ok: true });
  });

  app.delete('/sessions/:sessionId', async (c) => {
    const userId = c.get('userId');
    const sessionId = c.req.param('sessionId');
    if (!(await sessionBelongsTo(sessionId, userId))) {
      return c.json({ error: 'not found' }, 404);
    }
    try {
      await deps.signalClose?.(`${WF_PREFIX}${sessionId}`);
    } catch { /* ignore */ }
    const ok = await deleteSession(sessionId, userId);
    if (!ok) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  app.get('/sessions/:sessionId/stream', async (c) => {
    const userId = c.get('userId');
    const sessionId = c.req.param('sessionId');
    if (!(await sessionBelongsTo(sessionId, userId))) {
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
        for await (const { id, event } of subscribeDeltas(sessionId, from, abort.signal)) {
          await sse.writeSSE({ id, data: JSON.stringify(event) });
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
    signalWithStart: (wf, opts) => client.workflow.signalWithStart(wf, opts) as any,
    taskQueue,
    signalClose: async (workflowId) => {
      try {
        await client.workflow.getHandle(workflowId).signal(closeSignal);
      } catch { /* ignore */ }
    },
    terminateLegacy: async (workflowId) => {
      try {
        await client.workflow.getHandle(workflowId).terminate('superseded by chat2 workflow shape');
        console.log(`[webhook] terminated legacy workflow ${workflowId}`);
      } catch { /* not running — nothing to do */ }
    },
    steerExperiment: async (sessionId, msg) => {
      const exp = await getExperimentBySession(sessionId).catch(() => null);
      if (!exp) return false;
      // Swallow the bridge's own join/prime notices; steer everything else.
      if (!msg.includes('[irc bridge')) {
        try {
          await client.workflow
            .getHandle(`auto:${exp.name}`)
            .signal(experimentSteerSignal, msg);
        } catch (err) {
          console.error(`[webhook] experiment steer failed for ${exp.name}:`, (err as Error).message);
        }
      }
      return true;
    },
  });

  console.log(`Webhook listening on :${port}`);
  serve({ fetch: app.fetch, port });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
