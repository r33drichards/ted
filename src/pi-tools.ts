/**
 * Tool definitions for the ted agent: mcp-js code execution (via its REST
 * sidecar), memory CRUD, and raw IRC commands.
 *
 * Tools are plain objects: the LLM-facing schema (given to pi-ai's stream
 * call by the llmTurn activity) plus an execute() run by the executeTool
 * activity. Each tool execution is its own Temporal activity.
 */
import { Type, type TSchema } from '@earendil-works/pi-ai';
import {
  setMemory,
  getMemory,
  deleteMemory,
  listMemories,
  searchMemories,
  type MemoryTier,
} from './db.js';

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
        'write results you want to keep to variables; they persist in the session heap.',
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
