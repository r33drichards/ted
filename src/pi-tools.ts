/**
 * Custom pi tools for the ted agent: mcp-js code execution (via its REST
 * sidecar), memory CRUD, and raw IRC commands.
 */
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  setMemory,
  getMemory,
  deleteMemory,
  listMemories,
  searchMemories,
  type MemoryTier,
} from './db.js';

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

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }], details: {} };
}

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

async function runJs(code: string, session: string): Promise<string> {
  const submitted = await fetchJson(`${MCP_JS_ORIGIN}/api/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, session }),
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

const tierEnum = Type.Union([
  Type.Literal('working'),
  Type.Literal('short_term'),
  Type.Literal('long_term'),
]);

export function createTedTools(userId: string): ToolDefinition<any, any, any>[] {
  return [
    defineTool({
      name: 'run_js',
      label: 'Run JavaScript',
      description:
        'Execute JavaScript in a sandboxed V8 runtime (mcp-js). State persists across calls ' +
        'within the same named session via heap snapshots. Returns console output. ' +
        'No filesystem or network access inside the sandbox by default.',
      parameters: Type.Object({
        code: Type.String({ description: 'JavaScript source to execute' }),
        session: Type.Optional(
          Type.String({ description: 'Named session for state persistence (default "ted")' }),
        ),
      }),
      execute: async (_id, params) => {
        try {
          return text(await runJs(params.code, params.session ?? 'ted'));
        } catch (err) {
          return text(`run_js failed: ${(err as Error).message}`);
        }
      },
    }),

    defineTool({
      name: 'memory_set',
      label: 'Save memory',
      description:
        'Create or update a memory. working = always in context, short_term = index in context, long_term = searchable.',
      parameters: Type.Object({
        tier: tierEnum,
        key: Type.String(),
        content: Type.String(),
      }),
      execute: async (_id, params) => {
        await setMemory(userId, params.tier as MemoryTier, params.key, params.content);
        return text(`Memory "${params.key}" saved to ${params.tier}.`);
      },
    }),

    defineTool({
      name: 'memory_get',
      label: 'Read memory',
      description: 'Read the full content of a memory by key.',
      parameters: Type.Object({ key: Type.String() }),
      execute: async (_id, params) => {
        const mem = await getMemory(userId, params.key);
        if (!mem) return text(`No memory found with key "${params.key}".`);
        return text(`[${mem.tier}] ${mem.key}:\n${mem.content}`);
      },
    }),

    defineTool({
      name: 'memory_delete',
      label: 'Delete memory',
      description: 'Delete a memory by key.',
      parameters: Type.Object({ key: Type.String() }),
      execute: async (_id, params) => {
        const ok = await deleteMemory(userId, params.key);
        return text(ok ? `Deleted "${params.key}".` : `No memory "${params.key}".`);
      },
    }),

    defineTool({
      name: 'memory_list',
      label: 'List memories',
      description: 'List all memories, optionally filtered by tier.',
      parameters: Type.Object({ tier: Type.Optional(tierEnum) }),
      execute: async (_id, params) => {
        const mems = await listMemories(userId, params.tier as MemoryTier | undefined);
        if (mems.length === 0) return text('No memories found.');
        const lines = mems.map((m) => {
          const preview = m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content;
          return `[${m.tier}] ${m.key}: ${preview}`;
        });
        return text(lines.join('\n'));
      },
    }),

    defineTool({
      name: 'memory_search',
      label: 'Search memories',
      description: 'Search memories by keyword across keys and content.',
      parameters: Type.Object({
        query: Type.String(),
        tier: Type.Optional(tierEnum),
      }),
      execute: async (_id, params) => {
        const results = await searchMemories(userId, params.query, params.tier as MemoryTier | undefined);
        if (results.length === 0) return text(`No memories matching "${params.query}".`);
        const lines = results.map((m) => {
          const preview = m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content;
          return `[${m.tier}] ${m.key}: ${preview}`;
        });
        return text(lines.join('\n'));
      },
    }),

    defineTool({
      name: 'irc_raw',
      label: 'Raw IRC command',
      description:
        'Send a raw IRC command via the IRC bridge. One line, no CR/LF. ' +
        'Examples: "JOIN #foo", "PART #foo :bye", "PRIVMSG #foo :hello there", ' +
        '"TOPIC #foo :new topic", "NICK other-nick". After a successful JOIN ' +
        'the bridge auto-starts a per-channel session (irc-<name without # or &>) ' +
        'so future privmsgs from that channel will arrive as new turns.',
      parameters: Type.Object({ line: Type.String() }),
      execute: async (_id, params) => {
        const url = process.env.IRC_BRIDGE_URL;
        if (!url) return text('IRC bridge not configured (IRC_BRIDGE_URL unset).');
        try {
          const res = await fetch(`${url}/irc/raw`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ line: params.line }),
          });
          const body = await res.text();
          if (!res.ok) return text(`IRC bridge ${res.status}: ${body}`);
          return text(`IRC: ${params.line}`);
        } catch (err) {
          return text(`IRC bridge unreachable: ${(err as Error).message}`);
        }
      },
    }),
  ];
}
