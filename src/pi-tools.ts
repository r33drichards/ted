/**
 * Tool definitions for the ted agent: mcp-js code execution (via its REST
 * sidecar), memory CRUD, and raw IRC commands.
 *
 * Tools are plain objects: the LLM-facing schema (given to pi-ai's stream
 * call by the llmTurn activity) plus an execute() run by the executeTool
 * activity. Each tool execution is its own Temporal activity.
 */
import { Type, type TSchema } from '@earendil-works/pi-ai';
import { ScheduleOverlapPolicy } from '@temporalio/client';
import {
  setMemory,
  getMemory,
  deleteMemory,
  listMemories,
  searchMemories,
  createExperiment,
  getExperiment,
  listExperiments,
  listExperimentRuns,
  setExperimentStatus,
  ExperimentExistsError,
  listAutojoinChannels,
  addAutojoinChannel,
  removeAutojoinChannel,
  type MemoryTier,
} from './db.js';
import { getTemporalClient, TASK_QUEUE } from './temporal-client.js';
import { experimentSteerSignal } from './signals.js';

/** '#chan' → 'irc-chan' (the bridge's session naming). */
export function channelToSession(channel: string): string {
  return `irc-${channel.replace(/^[#&]/, '')}`;
}

const CHANNEL_RE = /^[#&][^\s,]{1,49}$/;

/** Cron expression (with year field) that fires once at the given UTC time. */
export function oneShotCron(d: Date): string {
  return `${d.getUTCMinutes()} ${d.getUTCHours()} ${d.getUTCDate()} ${d.getUTCMonth() + 1} * ${d.getUTCFullYear()}`;
}

export type TedTool = {
  name: string;
  description: string;
  parameters: TSchema;
  execute: (args: any) => Promise<{ text: string; isError?: boolean }>;
};

// REST sidecar of the mcp-js (mcp-v8) service. MCP_JS_URL points at the MCP
// endpoint (…/mcp); the REST API lives at the same origin under /api.
const MCP_JS_ORIGIN = (() => {
  const url = process.env.MCP_JS_URL ?? 'http://mcp-js-p1ze.railway.internal:8080/mcp';
  try {
    return new URL(url).origin;
  } catch {
    return 'http://mcp-js-p1ze.railway.internal:8080';
  }
})();

const RUN_JS_TIMEOUT_MS = Number(process.env.MCP_JS_TIMEOUT_MS ?? 120_000);

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  const body = await res.text();
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${body.slice(0, 500)}`);
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export async function runJs(code: string, session?: string): Promise<string> {
  const submitted = await fetchJson(`${MCP_JS_ORIGIN}/api/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(session ? { code, session } : { code }),
  });

  // Stateless mode returns { output, error } directly.
  if (submitted && typeof submitted === 'object' && !('execution_id' in submitted)) {
    const out = submitted.output ?? '';
    const err = submitted.error ? `\n[error] ${submitted.error}` : '';
    return `${out}${err}` || '(no output)';
  }

  // Stateful mode: poll the execution until it settles.
  const id = submitted.execution_id;
  const deadline = Date.now() + RUN_JS_TIMEOUT_MS;
  let last: any = submitted;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    last = await fetchJson(`${MCP_JS_ORIGIN}/api/executions/${encodeURIComponent(id)}`);
    const status = String(last?.status ?? last?.state ?? '').toLowerCase();
    if (status && !['queued', 'pending', 'running', 'in_progress'].includes(status)) break;
  }

  let output = '';
  try {
    const out = await fetch(`${MCP_JS_ORIGIN}/api/executions/${encodeURIComponent(id)}/output`);
    output = await out.text();
  } catch {
    // fall back to whatever the status payload carried
  }

  const statusJson = typeof last === 'string' ? last : JSON.stringify(last);
  return `status: ${statusJson}\noutput:\n${output || '(no output)'}`;
}

/** Send one raw IRC line via the bridge's private HTTP endpoint. */
export async function ircRawLine(line: string): Promise<void> {
  const url = process.env.IRC_BRIDGE_URL;
  if (!url) throw new Error('IRC bridge not configured (IRC_BRIDGE_URL unset)');
  const res = await fetch(`${url}/irc/raw`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ line }),
  });
  if (!res.ok) throw new Error(`IRC bridge ${res.status}: ${await res.text()}`);
}

/** Say text in a channel, split into IRC-safe chunks. */
export async function ircSayLines(channel: string, text: string): Promise<void> {
  const oneline = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (!oneline) return;
  const words = oneline.split(' ');
  const chunks: string[] = [];
  let buf = '';
  for (const word of words) {
    const candidate = buf ? `${buf} ${word}` : word;
    if (Buffer.byteLength(candidate) <= 400) {
      buf = candidate;
    } else {
      if (buf) chunks.push(buf);
      buf = word.slice(0, 400);
    }
  }
  if (buf) chunks.push(buf);
  for (const chunk of chunks) {
    await ircRawLine(`PRIVMSG ${channel} :${chunk}`);
  }
}

const tierEnum = Type.Union([
  Type.Literal('working'),
  Type.Literal('short_term'),
  Type.Literal('long_term'),
]);

export function createTedTools(userId: string): TedTool[] {
  return [
    {
      name: 'run_js',
      description:
        'Execute JavaScript in a sandboxed V8 runtime (mcp-js). State persists across calls ' +
        'within the same named session via heap snapshots. Returns console output. ' +
        'fetch() has full network access, and external ES modules can be imported with ' +
        'npm:/jsr: specifiers or https URLs (resolved via esm.sh), e.g. ' +
        '`import git from "npm:isomorphic-git"`. node: builtins (node:path, node:buffer, ' +
        'node:url, node:events, ...) and web APIs (URL, streams, TextDecoder, crypto, ' +
        'CompressionStream) are available. Heap limit 512 MB, execution timeout 120 s — ' +
        'write results you want to keep to variables; they persist in the session heap. ' +
        'WordPress administration: fetch() calls to https://www.robw.fyi are automatically ' +
        'authenticated server-side as admin user r33drichards (no Authorization header ' +
        'needed, credentials are injected at egress) — use the REST API at ' +
        'https://www.robw.fyi/wp-json/wp/v2/... to read and administrate the site ' +
        '(posts, pages, users, plugins, settings).',
      parameters: Type.Object({
        code: Type.String({ description: 'JavaScript source to execute' }),
        session: Type.Optional(
          Type.String({ description: 'Named session for state persistence (default "ted")' }),
        ),
      }),
      execute: async (args) => {
        try {
          return { text: await runJs(String(args.code ?? ''), String(args.session ?? 'ted')) };
        } catch (err) {
          return { text: `run_js failed: ${(err as Error).message}`, isError: true };
        }
      },
    },

    {
      name: 'memory_set',
      description:
        'Create or update a memory. working = always in context, short_term = index in context, long_term = searchable.',
      parameters: Type.Object({
        tier: tierEnum,
        key: Type.String(),
        content: Type.String(),
      }),
      execute: async (args) => {
        await setMemory(userId, args.tier as MemoryTier, args.key, args.content);
        return { text: `Memory "${args.key}" saved to ${args.tier}.` };
      },
    },

    {
      name: 'memory_get',
      description: 'Read the full content of a memory by key.',
      parameters: Type.Object({ key: Type.String() }),
      execute: async (args) => {
        const mem = await getMemory(userId, args.key);
        if (!mem) return { text: `No memory found with key "${args.key}".` };
        return { text: `[${mem.tier}] ${mem.key}:\n${mem.content}` };
      },
    },

    {
      name: 'memory_delete',
      description: 'Delete a memory by key.',
      parameters: Type.Object({ key: Type.String() }),
      execute: async (args) => {
        const ok = await deleteMemory(userId, args.key);
        return { text: ok ? `Deleted "${args.key}".` : `No memory "${args.key}".` };
      },
    },

    {
      name: 'memory_list',
      description: 'List all memories, optionally filtered by tier.',
      parameters: Type.Object({ tier: Type.Optional(tierEnum) }),
      execute: async (args) => {
        const mems = await listMemories(userId, args.tier as MemoryTier | undefined);
        if (mems.length === 0) return { text: 'No memories found.' };
        const lines = mems.map((m) => {
          const preview = m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content;
          return `[${m.tier}] ${m.key}: ${preview}`;
        });
        return { text: lines.join('\n') };
      },
    },

    {
      name: 'memory_search',
      description: 'Search memories by keyword across keys and content.',
      parameters: Type.Object({
        query: Type.String(),
        tier: Type.Optional(tierEnum),
      }),
      execute: async (args) => {
        const results = await searchMemories(userId, args.query, args.tier as MemoryTier | undefined);
        if (results.length === 0) return { text: `No memories matching "${args.query}".` };
        const lines = results.map((m) => {
          const preview = m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content;
          return `[${m.tier}] ${m.key}: ${preview}`;
        });
        return { text: lines.join('\n') };
      },
    },

    {
      name: 'experiment_start',
      description:
        'Start an autonomous autoresearch experiment (pi-autoresearch pattern): a durable ' +
        'loop that repeatedly proposes candidate JavaScript, measures it in the sandbox, and ' +
        'keeps only what improves the metric. Creates IRC channel #auto-<name> for progress ' +
        'and steering (say "stop", "pause", "resume", "status", or free-form guidance there). ' +
        'The measure snippet runs after the candidate code in the same execution and must ' +
        'print "METRIC <metric_name>=<number>".',
      parameters: Type.Object({
        name: Type.String({ description: 'Short slug, lowercase letters/digits/hyphens (e.g. "fib-speed")' }),
        goal: Type.String({ description: 'What to optimize, in plain language' }),
        metric_name: Type.String({ description: 'Metric identifier printed by the measure snippet' }),
        metric_unit: Type.Optional(Type.String({ description: 'Unit suffix for display (e.g. "ms")' })),
        direction: Type.Union([Type.Literal('min'), Type.Literal('max')]),
        measure_code: Type.String({
          description: 'JS that measures the candidate and prints METRIC <metric_name>=<number>',
        }),
      }),
      execute: async (args) => {
        const name = String(args.name ?? '').trim();
        if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(name)) {
          return { text: 'Invalid name: use lowercase letters, digits, hyphens (max 30 chars).', isError: true };
        }
        const channel = `#auto-${name}`;
        const channelSession = `irc-auto-${name}`;
        try {
          await createExperiment({
            name,
            userId,
            channel,
            channelSession,
            goal: String(args.goal),
            metricName: String(args.metric_name),
            metricUnit: String(args.metric_unit ?? ''),
            direction: args.direction as 'min' | 'max',
            measureCode: String(args.measure_code),
          });
        } catch (err) {
          if (err instanceof ExperimentExistsError) {
            return { text: `Experiment "${name}" already exists. Pick another name or stop it first.`, isError: true };
          }
          throw err;
        }
        try {
          await ircRawLine(`JOIN ${channel}`);
        } catch (err) {
          // Not fatal: the loop still runs; results just have nowhere to post
          // until the bridge joins the channel.
        }
        const client = await getTemporalClient();
        await client.workflow.start('autoresearch', {
          workflowId: `auto:${name}`,
          taskQueue: TASK_QUEUE,
          args: [name, userId, channel, args.direction, String(args.metric_unit ?? '')],
        });
        return {
          text:
            `Experiment "${name}" started — follow it in ${channel}. ` +
            `Say "status", "pause", "resume", "stop", or free-form guidance there.`,
        };
      },
    },

    {
      name: 'experiment_stop',
      description: 'Stop a running autoresearch experiment by name.',
      parameters: Type.Object({ name: Type.String() }),
      execute: async (args) => {
        const name = String(args.name ?? '').trim();
        const exp = await getExperiment(name);
        if (!exp) return { text: `No experiment named "${name}".`, isError: true };
        try {
          const client = await getTemporalClient();
          await client.workflow.getHandle(`auto:${name}`).signal(experimentSteerSignal, 'stop');
          return { text: `Stop signal sent to experiment "${name}".` };
        } catch {
          await setExperimentStatus(name, 'stopped');
          return { text: `Experiment "${name}" marked stopped (workflow was not running).` };
        }
      },
    },

    {
      name: 'experiment_status',
      description: 'Show autoresearch experiments and their current best values.',
      parameters: Type.Object({
        name: Type.Optional(Type.String({ description: 'Experiment name; omit to list all' })),
      }),
      execute: async (args) => {
        if (args.name) {
          const exp = await getExperiment(String(args.name));
          if (!exp) return { text: `No experiment named "${args.name}".`, isError: true };
          const runs = await listExperimentRuns(exp.name, 5);
          const lines = [
            `${exp.name} [${exp.status}] ${exp.channel} — ${exp.goal}`,
            `metric ${exp.metric_name} (${exp.direction}), best ${exp.best_value ?? 'n/a'}${exp.metric_unit}`,
            ...runs.reverse().map((r) => `#${r.iteration} ${r.verdict} ${r.value ?? 'n/a'} — ${r.description}`),
          ];
          return { text: lines.join('\n') };
        }
        const exps = await listExperiments(userId);
        if (exps.length === 0) return { text: 'No experiments yet.' };
        return {
          text: exps
            .map((e) => `${e.name} [${e.status}] best ${e.best_value ?? 'n/a'}${e.metric_unit} — ${e.goal}`)
            .join('\n'),
        };
      },
    },

    {
      name: 'schedule_create',
      description:
        'Create a recurring or one-shot scheduled prompt that fires into a channel’s chat ' +
        'session via a Temporal Schedule. Use cron for recurring (standard cron expression, UTC) ' +
        'or at for a one-time fire (ISO 8601 timestamp). When it fires, the prompt arrives as a ' +
        'new message ("scheduler: <prompt>") in that channel’s session and the agent acts on it.',
      parameters: Type.Object({
        id: Type.String({ description: 'Unique schedule identifier (e.g. "morning-report")' }),
        channel: Type.String({ description: 'Target IRC channel whose session receives the prompt (e.g. "#ted")' }),
        prompt: Type.String({ description: 'Prompt text sent when the schedule fires' }),
        cron: Type.Optional(Type.String({ description: 'Cron expression for recurring (e.g. "0 9 * * *"), UTC' })),
        at: Type.Optional(Type.String({ description: 'ISO 8601 timestamp for a one-shot fire' })),
      }),
      execute: async (args) => {
        const channel = String(args.channel ?? '').trim();
        if (!CHANNEL_RE.test(channel)) {
          return { text: `Invalid channel "${channel}".`, isError: true };
        }
        if (!args.cron && !args.at) {
          return { text: 'Provide either cron (recurring) or at (one-shot).', isError: true };
        }
        const spec: any = {};
        let kind: string;
        if (args.cron) {
          spec.cronExpressions = [String(args.cron)];
          kind = `recurring (${args.cron})`;
        } else {
          const d = new Date(String(args.at));
          if (isNaN(d.getTime())) return { text: `Invalid timestamp: "${args.at}"`, isError: true };
          spec.cronExpressions = [oneShotCron(d)];
          kind = `one-shot (${d.toISOString()})`;
        }
        try {
          const client = await getTemporalClient();
          const handle = await client.schedule.create({
            scheduleId: String(args.id),
            spec,
            action: {
              type: 'startWorkflow' as const,
              workflowType: 'scheduledPrompt',
              taskQueue: TASK_QUEUE,
              args: [channelToSession(channel), userId, String(args.prompt)],
            },
            policies: { overlap: ScheduleOverlapPolicy.SKIP },
            ...(args.at ? { state: { remainingActions: 1 } } : {}),
          });
          return {
            text:
              `Created schedule "${handle.scheduleId}" — ${kind}\n` +
              `  target: ${channel}\n  prompt: ${args.prompt}`,
          };
        } catch (err) {
          return { text: `Failed to create schedule: ${(err as Error).message}`, isError: true };
        }
      },
    },

    {
      name: 'schedule_list',
      description: 'List scheduled prompts with paused state and next fire times.',
      parameters: Type.Object({}),
      execute: async () => {
        try {
          const client = await getTemporalClient();
          const lines: string[] = [];
          for await (const s of client.schedule.list()) {
            const paused = s.state.paused ? ' [PAUSED]' : '';
            const next = (s.info.nextActionTimes ?? [])
              .slice(0, 3)
              .map((d: Date) => d.toISOString())
              .join(', ');
            lines.push(`${s.scheduleId}${paused}${next ? ` — next: ${next}` : ''}`);
          }
          return { text: lines.length > 0 ? lines.join('\n') : 'No schedules.' };
        } catch (err) {
          return { text: `Failed to list schedules: ${(err as Error).message}`, isError: true };
        }
      },
    },

    {
      name: 'schedule_delete',
      description: 'Delete a scheduled prompt by ID.',
      parameters: Type.Object({ id: Type.String() }),
      execute: async (args) => {
        try {
          const client = await getTemporalClient();
          await client.schedule.getHandle(String(args.id)).delete();
          return { text: `Deleted schedule "${args.id}".` };
        } catch (err) {
          return { text: `Failed to delete schedule: ${(err as Error).message}`, isError: true };
        }
      },
    },

    {
      name: 'schedule_trigger',
      description: 'Manually fire a scheduled prompt immediately.',
      parameters: Type.Object({ id: Type.String() }),
      execute: async (args) => {
        try {
          const client = await getTemporalClient();
          await client.schedule.getHandle(String(args.id)).trigger();
          return { text: `Triggered schedule "${args.id}" — fires now.` };
        } catch (err) {
          return { text: `Failed to trigger schedule: ${(err as Error).message}`, isError: true };
        }
      },
    },

    {
      name: 'channels_list',
      description: 'List the channels the IRC bridge auto-joins on connect.',
      parameters: Type.Object({}),
      execute: async () => {
        const channels = await listAutojoinChannels(userId);
        return { text: channels.length > 0 ? channels.join(', ') : 'No autojoin channels configured.' };
      },
    },

    {
      name: 'channels_add',
      description:
        'Add a channel to the autojoin list (joined on every bridge connect) and join it now.',
      parameters: Type.Object({
        channel: Type.String({ description: 'Channel name, e.g. "#research"' }),
      }),
      execute: async (args) => {
        const channel = String(args.channel ?? '').trim();
        if (!CHANNEL_RE.test(channel)) return { text: `Invalid channel "${channel}".`, isError: true };
        await addAutojoinChannel(userId, channel);
        try {
          await ircRawLine(`JOIN ${channel}`);
          return { text: `Added ${channel} to autojoin and joined it.` };
        } catch (err) {
          return { text: `Added ${channel} to autojoin (join failed: ${(err as Error).message}).` };
        }
      },
    },

    {
      name: 'channels_remove',
      description: 'Remove a channel from the autojoin list and part it now.',
      parameters: Type.Object({
        channel: Type.String({ description: 'Channel name, e.g. "#research"' }),
      }),
      execute: async (args) => {
        const channel = String(args.channel ?? '').trim();
        const removed = await removeAutojoinChannel(userId, channel);
        if (!removed) return { text: `${channel} was not on the autojoin list.` };
        try {
          await ircRawLine(`PART ${channel} :removed from autojoin`);
        } catch {
          // bridge unreachable — the DB change still sticks
        }
        return { text: `Removed ${channel} from autojoin and parted it.` };
      },
    },

    {
      name: 'irc_raw',
      description:
        'Send a raw IRC command via the IRC bridge. One line, no CR/LF. ' +
        'Examples: "JOIN #foo", "PART #foo :bye", "PRIVMSG #foo :hello there", ' +
        '"TOPIC #foo :new topic", "NICK other-nick". After a successful JOIN ' +
        'the bridge auto-starts a per-channel session (irc-<name without # or &>) ' +
        'so future privmsgs from that channel will arrive as new turns.',
      parameters: Type.Object({ line: Type.String() }),
      execute: async (args) => {
        const url = process.env.IRC_BRIDGE_URL;
        if (!url) return { text: 'IRC bridge not configured (IRC_BRIDGE_URL unset).', isError: true };
        try {
          const res = await fetch(`${url}/irc/raw`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ line: args.line }),
          });
          const body = await res.text();
          if (!res.ok) return { text: `IRC bridge ${res.status}: ${body}`, isError: true };
          return { text: `IRC: ${args.line}` };
        } catch (err) {
          return { text: `IRC bridge unreachable: ${(err as Error).message}`, isError: true };
        }
      },
    },
  ];
}
