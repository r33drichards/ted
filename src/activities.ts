import Anthropic from '@anthropic-ai/sdk';
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import { heartbeat } from '@temporalio/activity';
import { publishDelta, publishTurnEnd } from './publish.js';
import {
  appendMessage,
  touchSession,
  renameSession,
  listEnabledMcpServers,
  listMcpServers,
  createMcpServer,
  deleteMcpServer,
  setMemory,
  getMemory,
  deleteMemory,
  listMemories,
  searchMemories,
  loadMemoryContext,
  McpNameTakenError,
  type McpServerRow,
  type MemoryTier,
} from './db.js';
import * as mcp from './mcp-client.js';
import type { Role, StreamReq } from './types.js';

// Bedrock when CLAUDE_CODE_USE_BEDROCK is set (any truthy value), else direct Anthropic API.
const useBedrock = !!process.env.CLAUDE_CODE_USE_BEDROCK;

const client = useBedrock
  ? new AnthropicBedrock({
      awsRegion: process.env.AWS_REGION ?? 'us-east-1',
    })
  : new Anthropic({ maxRetries: 0 }); // Temporal owns retries

const MODEL =
  process.env.ANTHROPIC_MODEL ??
  (useBedrock
    ? 'us.anthropic.claude-haiku-4-5-20251001-v1:0'
    : 'claude-opus-4-5');
const MAX_TOKENS = 16384;
const THINKING_BUDGET = 10000;

// Max tool-call loop iterations per user turn. Prevents a misbehaving model
// or server from cycling forever.
const MAX_TOOL_ROUNDS = 8;

/**
 * Tool name collisions across servers are resolved by prefixing with the
 * server name and a double-underscore: `vantage__list_instances`. Claude
 * sees the prefixed name; we strip it before dispatching to the MCP
 * server.
 */
function prefixToolName(server: McpServerRow, toolName: string): string {
  return `${server.name}__${toolName}`;
}
function splitPrefixedToolName(
  prefixed: string,
): { server: string; tool: string } | null {
  const i = prefixed.indexOf('__');
  if (i < 0) return null;
  return { server: prefixed.slice(0, i), tool: prefixed.slice(i + 2) };
}

type ClaudeTool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};

/**
 * Load tool definitions from every enabled MCP server for this user and
 * return them in the shape Claude's API expects. Tools an `allowed_tools`
 * list narrows to are filtered in. Servers that fail to respond are
 * logged and skipped — one bad server shouldn't break the chat.
 */
async function gatherMcpTools(userId: string): Promise<{
  tools: ClaudeTool[];
  // name -> server row, for dispatch
  byPrefixed: Map<string, { server: McpServerRow; original: string }>;
}> {
  const servers = await listEnabledMcpServers(userId);
  const tools: ClaudeTool[] = [];
  const byPrefixed = new Map<
    string,
    { server: McpServerRow; original: string }
  >();

  await Promise.all(
    servers.map(async (s) => {
      try {
        const remote = await mcp.listTools(s.url);
        for (const t of remote) {
          if (s.allowed_tools.length > 0 && !s.allowed_tools.includes(t.name)) {
            continue;
          }
          const prefixed = prefixToolName(s, t.name);
          tools.push({
            name: prefixed,
            description: t.description,
            input_schema: t.inputSchema,
          });
          byPrefixed.set(prefixed, { server: s, original: t.name });
        }
      } catch (err) {
        console.error(
          `[mcp] ${s.name}: tools/list failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );

  return { tools, byPrefixed };
}

/* ------------------------------------------------------------------ */
/*  Built-in tools — always available, let the agent manage its own   */
/*  MCP server list without leaving the conversation.                 */
/* ------------------------------------------------------------------ */

const BUILTIN_TOOLS: ClaudeTool[] = [
  {
    name: 'ted__add_mcp_server',
    description:
      'Add a remote MCP server so its tools become available to you. ' +
      'Provide a short name and the HTTP(S) URL of the server. ' +
      'After adding, the server\'s tools are usable immediately.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Short identifier for this server (e.g. "weather", "github")',
        },
        url: {
          type: 'string',
          description: 'HTTP(S) URL of the MCP server endpoint',
        },
      },
      required: ['name', 'url'],
    },
  },
  {
    name: 'ted__list_mcp_servers',
    description:
      'List all configured MCP servers, their URLs, and whether they are enabled.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'ted__remove_mcp_server',
    description: 'Remove an MCP server by name.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the MCP server to remove',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'ted__memory_set',
    description:
      'Create or update a memory. Tiers: "working" (always in context), ' +
      '"short_term" (index in context, read via ted__memory_get), ' +
      '"long_term" (searchable via ted__memory_search).',
    input_schema: {
      type: 'object',
      properties: {
        tier: {
          type: 'string',
          enum: ['working', 'short_term', 'long_term'],
          description: 'Memory tier',
        },
        key: {
          type: 'string',
          description: 'Short identifier for this memory',
        },
        content: {
          type: 'string',
          description: 'The memory content',
        },
      },
      required: ['tier', 'key', 'content'],
    },
  },
  {
    name: 'ted__memory_get',
    description: 'Read the full content of a memory by key.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key to read' },
      },
      required: ['key'],
    },
  },
  {
    name: 'ted__memory_delete',
    description: 'Delete a memory by key.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key to delete' },
      },
      required: ['key'],
    },
  },
  {
    name: 'ted__memory_list',
    description: 'List all memories, optionally filtered by tier.',
    input_schema: {
      type: 'object',
      properties: {
        tier: {
          type: 'string',
          enum: ['working', 'short_term', 'long_term'],
          description: 'Filter by tier (omit for all)',
        },
      },
    },
  },
  {
    name: 'ted__memory_search',
    description:
      'Search memories by keyword. Searches both keys and content. ' +
      'Best for finding long-term memories.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        tier: {
          type: 'string',
          enum: ['working', 'short_term', 'long_term'],
          description: 'Filter by tier (omit for all)',
        },
      },
      required: ['query'],
    },
  },
];

const BUILTIN_NAMES = new Set(BUILTIN_TOOLS.map((t) => t.name));

/**
 * Execute a built-in tool. Returns the textual result and a flag
 * indicating whether the MCP tool set changed (so the caller can
 * re-gather).
 */
async function handleBuiltinTool(
  userId: string,
  sessionId: string,
  name: string,
  input: Record<string, unknown>,
): Promise<{ content: string; toolsChanged: boolean }> {
  switch (name) {
    case 'ted__add_mcp_server': {
      const sName = String(input.name ?? '').trim();
      const sUrl = String(input.url ?? '').trim();
      if (!sName) return { content: 'error: name is required', toolsChanged: false };
      if (!sUrl) return { content: 'error: url is required', toolsChanged: false };
      try {
        new URL(sUrl); // validate
      } catch {
        return { content: `error: invalid url: ${sUrl}`, toolsChanged: false };
      }
      try {
        await createMcpServer(userId, { name: sName, url: sUrl });
      } catch (err) {
        if (err instanceof McpNameTakenError) {
          return {
            content: `error: a server named "${sName}" already exists`,
            toolsChanged: false,
          };
        }
        throw err;
      }
      // Verify connectivity and list available tools.
      try {
        const tools = await mcp.listTools(sUrl);
        const names = tools.map((t) => t.name).join(', ');
        return {
          content:
            `Added MCP server "${sName}" (${sUrl}). ` +
            `${tools.length} tool(s) available: ${names}`,
          toolsChanged: true,
        };
      } catch (err) {
        return {
          content:
            `Added MCP server "${sName}" (${sUrl}), but failed to connect: ` +
            (err instanceof Error ? err.message : String(err)) +
            '. The server is saved and will be retried on the next turn.',
          toolsChanged: true,
        };
      }
    }

    case 'ted__list_mcp_servers': {
      const servers = await listMcpServers(userId);
      if (servers.length === 0) {
        return { content: 'No MCP servers configured.', toolsChanged: false };
      }
      const lines = servers.map(
        (s) =>
          `• ${s.name} — ${s.url} (${s.enabled ? 'enabled' : 'disabled'})`,
      );
      return { content: lines.join('\n'), toolsChanged: false };
    }

    case 'ted__remove_mcp_server': {
      const rName = String(input.name ?? '').trim();
      if (!rName)
        return { content: 'error: name is required', toolsChanged: false };
      const servers = await listMcpServers(userId);
      const target = servers.find((s) => s.name === rName);
      if (!target) {
        return {
          content: `No server named "${rName}" found.`,
          toolsChanged: false,
        };
      }
      await deleteMcpServer(target.id, userId);
      return {
        content: `Removed MCP server "${rName}".`,
        toolsChanged: true,
      };
    }

    case 'ted__memory_set': {
      const tier = String(input.tier ?? '') as MemoryTier;
      const mKey = String(input.key ?? '').trim();
      const mContent = String(input.content ?? '');
      if (!['working', 'short_term', 'long_term'].includes(tier))
        return { content: 'error: tier must be working, short_term, or long_term', toolsChanged: false };
      if (!mKey) return { content: 'error: key is required', toolsChanged: false };
      if (!mContent) return { content: 'error: content is required', toolsChanged: false };
      await setMemory(userId, tier, mKey, mContent);
      return { content: `Memory "${mKey}" saved to ${tier}.`, toolsChanged: false };
    }

    case 'ted__memory_get': {
      const gKey = String(input.key ?? '').trim();
      if (!gKey) return { content: 'error: key is required', toolsChanged: false };
      const mem = await getMemory(userId, gKey);
      if (!mem) return { content: `No memory found with key "${gKey}".`, toolsChanged: false };
      return { content: `[${mem.tier}] ${mem.key}:\n${mem.content}`, toolsChanged: false };
    }

    case 'ted__memory_delete': {
      const dKey = String(input.key ?? '').trim();
      if (!dKey) return { content: 'error: key is required', toolsChanged: false };
      const deleted = await deleteMemory(userId, dKey);
      return {
        content: deleted ? `Memory "${dKey}" deleted.` : `No memory found with key "${dKey}".`,
        toolsChanged: false,
      };
    }

    case 'ted__memory_list': {
      const lTier = input.tier ? String(input.tier) as MemoryTier : undefined;
      const mems = await listMemories(userId, lTier);
      if (mems.length === 0)
        return { content: 'No memories found.', toolsChanged: false };
      const lines = mems.map((m) => {
        const preview = m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content;
        return `[${m.tier}] ${m.key}: ${preview}`;
      });
      return { content: lines.join('\n'), toolsChanged: false };
    }

    case 'ted__memory_search': {
      const q = String(input.query ?? '').trim();
      if (!q) return { content: 'error: query is required', toolsChanged: false };
      const sTier = input.tier ? String(input.tier) as MemoryTier : undefined;
      const results = await searchMemories(userId, q, sTier);
      if (results.length === 0)
        return { content: `No memories matching "${q}".`, toolsChanged: false };
      const lines = results.map((m) => {
        const preview = m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content;
        return `[${m.tier}] ${m.key}: ${preview}`;
      });
      return { content: lines.join('\n'), toolsChanged: false };
    }

    default:
      return { content: `unknown builtin tool: ${name}`, toolsChanged: false };
  }
}

type ContentBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
} & Record<string, unknown>;

async function runOneStream(
  params: Record<string, unknown>,
  sessionId: string,
): Promise<ContentBlock[]> {
  // The two SDKs have nominally-different stream typings that don't share a
  // callable signature — cast through unknown and rely on the wire shape.
  const stream = (client.messages as unknown as {
    stream: (p: unknown) => {
      [Symbol.asyncIterator](): AsyncIterator<
        { type: string; delta?: { type: string; text?: string } }
      >;
      finalMessage(): Promise<{ content: ContentBlock[]; stop_reason?: string }>;
    };
  }).stream(params);

  for await (const event of stream) {
    if (event.type === 'content_block_delta') {
      const delta = event.delta as { type: string; text?: string; thinking?: string };
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        await publishDelta(sessionId, delta.text);
      } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        await publishDelta(sessionId, delta.thinking);
      }
      heartbeat();
    }
  }
  const final = await stream.finalMessage();
  return final.content as ContentBlock[];
}

/**
 * Stream an assistant turn. If the user has enabled MCP servers, fetch
 * their tool definitions and inject them into Claude's `tools` param. When
 * Claude returns `tool_use` blocks, dispatch the calls to the appropriate
 * MCP server, append the results, and re-prompt. Loops up to
 * MAX_TOOL_ROUNDS times.
 *
 * Returns the final assistant-visible text (concatenation of all text
 * blocks from the last round).
 */
export async function streamClaude(req: StreamReq): Promise<string> {
  let { tools: mcpTools, byPrefixed } = await gatherMcpTools(req.userId);
  let allTools: ClaudeTool[] = [...BUILTIN_TOOLS, ...mcpTools];

  // Load memories fresh every turn so changes are reflected immediately.
  const memoryCtx = await loadMemoryContext(req.userId);
  const systemParts: string[] = [];
  if (req.systemPrompt) systemParts.push(req.systemPrompt);
  if (memoryCtx) systemParts.push(memoryCtx);
  const systemPrompt = systemParts.join('\n\n') || undefined;

  // Messages start from history; we append assistant/tool_result rounds here.
  const messages: Array<{ role: string; content: unknown }> = req.history.map(
    (m) => ({ role: m.role, content: m.content }),
  );

  let lastAssistantText = '';

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const params: Record<string, unknown> = {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages,
        tools: [
          ...allTools,
          { type: 'web_search_20250305' },
          { type: 'code_execution_20250522' },
        ],
        thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET },
        ...(systemPrompt ? { system: systemPrompt } : {}),
      };

      const content = await runOneStream(params, req.sessionId);

      // Extract text from this round (skip thinking blocks, keep text blocks).
      lastAssistantText = content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');

      const toolUses = content.filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0) return lastAssistantText;

      // Echo the assistant message back into history exactly as it was.
      messages.push({ role: 'assistant', content });

      // Dispatch each tool call sequentially. Parallel would be fine but
      // sequential keeps error isolation simple.
      const toolResults: ContentBlock[] = [];
      let toolsChanged = false;

      for (const tu of toolUses) {
        const prefixed = tu.name ?? '';

        // Built-in tools (MCP server management)
        if (BUILTIN_NAMES.has(prefixed)) {
          heartbeat();
          const result = await handleBuiltinTool(
            req.userId,
            req.sessionId,
            prefixed,
            (tu.input as Record<string, unknown>) ?? {},
          );
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: result.content,
          });
          if (result.toolsChanged) toolsChanged = true;
          continue;
        }

        // MCP server tools
        const lookup = byPrefixed.get(prefixed);
        if (!lookup) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: `unknown tool: ${prefixed}`,
            is_error: true,
          });
          continue;
        }
        try {
          heartbeat();
          const res = await mcp.callTool(
            lookup.server.url,
            lookup.original,
            (tu.input as Record<string, unknown>) ?? {},
          );
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: res.content,
            ...(res.isError ? { is_error: true } : {}),
          });
        } catch (err) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content:
              err instanceof Error ? err.message : 'tool call failed',
            is_error: true,
          });
        }
      }

      // If MCP config changed, refresh the tool set for subsequent rounds.
      if (toolsChanged) {
        const refreshed = await gatherMcpTools(req.userId);
        mcpTools = refreshed.tools;
        byPrefixed = refreshed.byPrefixed;
        allTools = [...BUILTIN_TOOLS, ...mcpTools];
      }

      messages.push({ role: 'user', content: toolResults });
    }

    // Ran out of rounds — return whatever text we last saw. Caller will
    // still persist this into history.
    return lastAssistantText;
  } finally {
    await publishTurnEnd(req.sessionId);
  }
}

export type PersistTurnReq = {
  sessionId: string;
  role: Role;
  content: string;
  userId: string;
};

export async function persistTurn(req: PersistTurnReq): Promise<void> {
  await appendMessage(req.sessionId, req.role, req.content, req.userId);
  await touchSession(req.sessionId);
}

const TITLE_MODEL =
  process.env.ANTHROPIC_TITLE_MODEL ??
  (useBedrock
    ? 'us.anthropic.claude-haiku-4-5-20251001-v1:0'
    : 'claude-haiku-4-5');

export type GenerateTitleReq = {
  sessionId: string;
  userMessage: string;
  userId: string;
};

/**
 * Best-effort: ask Haiku for a short title based on the first user message
 * and save it on the sessions row. Failures are swallowed; the sidebar
 * falls back to the session id prefix until something succeeds.
 */
export async function generateTitle(req: GenerateTitleReq): Promise<void> {
  try {
    const resp = (await (
      client.messages.create as (args: unknown) => Promise<unknown>
    )({
      model: TITLE_MODEL,
      max_tokens: 40,
      messages: [
        {
          role: 'user',
          content:
            'Summarise the following message as a concise 3-6 word chat ' +
            'title. Reply with ONLY the title text, no quotes, no ' +
            "punctuation, no leading 'Title:'.\n\n" +
            req.userMessage,
        },
      ],
    })) as { content: Array<{ type: string; text?: string }> };
    let title = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
      .trim();
    title = title
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/\.+$/, '')
      .slice(0, 80)
      .trim();
    if (!title) return;
    await renameSession(req.sessionId, req.userId, title);
  } catch {
    // Best-effort; ignore failures.
  }
}
