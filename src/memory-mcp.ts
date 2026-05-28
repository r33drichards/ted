/**
 * In-process MCP server exposing memory CRUD and MCP server management.
 * Passed to the Agent SDK via `mcpServers` so the agent can manage
 * memories and its own tool servers without custom built-in tools.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import { writeFileSync, mkdirSync } from 'fs';
import {
  setMemory,
  getMemory,
  deleteMemory,
  listMemories,
  searchMemories,
  listMcpServers,
  createMcpServer,
  deleteMcpServer,
  McpNameTakenError,
  type MemoryTier,
} from './db.js';

const tierEnum = z.enum(['working', 'short_term', 'long_term']);

const PLUGIN_MCP_JSON = '/app/ted-plugin/.mcp.json';

/**
 * Sync the DB mcp_servers to the plugin's .mcp.json so the SDK
 * discovers them on next session. Also returns the config for
 * programmatic use.
 */
async function syncMcpJson(userId: string): Promise<Record<string, any>> {
  const servers = await listMcpServers(userId);
  const config: Record<string, any> = {};
  for (const s of servers) {
    if (s.transport === 'stdio' && s.command) {
      config[s.name] = { command: s.command, args: s.args ?? [] };
    } else if (s.url) {
      config[s.name] = { type: 'http', url: s.url };
    }
  }
  try {
    writeFileSync(PLUGIN_MCP_JSON, JSON.stringify({ mcpServers: config }, null, 2));
  } catch {
    // Volume might not be writable, ignore
  }
  return config;
}

export function createTedMcpServer(userId: string) {
  return createSdkMcpServer({
    name: 'ted',
    version: '1.0.0',
    tools: [
      // ---- Memory tools ----
      tool(
        'memory_set',
        'Create or update a memory. working = always in context, short_term = index in context, long_term = searchable.',
        { tier: tierEnum, key: z.string(), content: z.string() },
        async (args) => {
          await setMemory(userId, args.tier as MemoryTier, args.key, args.content);
          return { content: [{ type: 'text', text: `Memory "${args.key}" saved to ${args.tier}.` }] };
        },
      ),
      tool(
        'memory_get',
        'Read the full content of a memory by key.',
        { key: z.string() },
        async (args) => {
          const mem = await getMemory(userId, args.key);
          if (!mem) return { content: [{ type: 'text', text: `No memory found with key "${args.key}".` }] };
          return { content: [{ type: 'text', text: `[${mem.tier}] ${mem.key}:\n${mem.content}` }] };
        },
      ),
      tool(
        'memory_delete',
        'Delete a memory by key.',
        { key: z.string() },
        async (args) => {
          const ok = await deleteMemory(userId, args.key);
          return {
            content: [{ type: 'text', text: ok ? `Deleted "${args.key}".` : `No memory "${args.key}".` }],
          };
        },
      ),
      tool(
        'memory_list',
        'List all memories, optionally filtered by tier.',
        { tier: tierEnum.optional() },
        async (args) => {
          const mems = await listMemories(userId, args.tier as MemoryTier | undefined);
          if (mems.length === 0) return { content: [{ type: 'text', text: 'No memories found.' }] };
          const lines = mems.map((m) => {
            const preview = m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content;
            return `[${m.tier}] ${m.key}: ${preview}`;
          });
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        },
      ),
      tool(
        'memory_search',
        'Search memories by keyword across keys and content.',
        { query: z.string(), tier: tierEnum.optional() },
        async (args) => {
          const results = await searchMemories(userId, args.query, args.tier as MemoryTier | undefined);
          if (results.length === 0) return { content: [{ type: 'text', text: `No memories matching "${args.query}".` }] };
          const lines = results.map((m) => {
            const preview = m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content;
            return `[${m.tier}] ${m.key}: ${preview}`;
          });
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        },
      ),

      // ---- MCP server management tools ----
      tool(
        'mcp_add',
        'Add an MCP tool server. For HTTP servers provide url. For stdio servers (local commands) provide command and args. The server becomes available on the next turn.',
        {
          name: z.string().describe('Short identifier (e.g. "github", "runno")'),
          url: z.string().optional().describe('HTTP(S) URL for HTTP transport'),
          command: z.string().optional().describe('Command for stdio transport (e.g. "npx")'),
          args: z.array(z.string()).optional().describe('Args for stdio transport (e.g. ["@runno/mcp"])'),
        },
        async (input) => {
          if (!input.url && !input.command) {
            return { content: [{ type: 'text', text: 'Provide either url (HTTP) or command (stdio).' }] };
          }
          const transport = input.command ? 'stdio' : 'http';
          try {
            await createMcpServer(userId, {
              name: input.name,
              url: input.url,
              transport: transport as any,
              command: input.command,
              args: input.args,
            });
          } catch (err) {
            if (err instanceof McpNameTakenError) {
              return { content: [{ type: 'text', text: `Server "${input.name}" already exists.` }] };
            }
            throw err;
          }
          const config = await syncMcpJson(userId);
          const label = input.command ? `${input.command} ${(input.args ?? []).join(' ')}` : input.url!;
          return {
            content: [{
              type: 'text',
              text: `Added MCP server "${input.name}" (${transport}: ${label}). ` +
                    `It will be available on the next turn. ` +
                    `Plugin .mcp.json updated with ${Object.keys(config).length} server(s).`,
            }],
          };
        },
      ),
      tool(
        'mcp_list',
        'List all configured MCP tool servers.',
        {},
        async () => {
          const servers = await listMcpServers(userId);
          if (servers.length === 0) return { content: [{ type: 'text', text: 'No MCP servers configured.' }] };
          const lines = servers.map((s) => {
            const label = s.transport === 'stdio' && s.command
              ? `${s.command} ${(s.args ?? []).join(' ')}`
              : s.url ?? 'unknown';
            return `${s.name} — ${s.transport}: ${label} (${s.enabled ? 'enabled' : 'disabled'})`;
          });
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        },
      ),
      tool(
        'mcp_remove',
        'Remove an MCP tool server by name.',
        { name: z.string() },
        async (input) => {
          const servers = await listMcpServers(userId);
          const target = servers.find((s) => s.name === input.name);
          if (!target) return { content: [{ type: 'text', text: `No server named "${input.name}".` }] };
          await deleteMcpServer(target.id, userId);
          await syncMcpJson(userId);
          return { content: [{ type: 'text', text: `Removed "${input.name}".` }] };
        },
      ),

      // ---- IRC bridge ----
      tool(
        'irc_raw',
        'Send a raw IRC command via the IRC bridge. One line, no CR/LF. ' +
        'Examples: "JOIN #foo", "PART #foo :bye", "PRIVMSG #foo :hello there", ' +
        '"TOPIC #foo :new topic", "NICK other-nick". After a successful JOIN ' +
        'the bridge auto-starts a per-channel session (irc-<name without # or &>) ' +
        'so future privmsgs from that channel will arrive as new turns.',
        { line: z.string() },
        async (args) => {
          const url = process.env.IRC_BRIDGE_URL;
          if (!url) {
            return { content: [{ type: 'text', text: 'IRC bridge not configured (IRC_BRIDGE_URL unset).' }] };
          }
          try {
            const res = await fetch(`${url}/irc/raw`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ line: args.line }),
            });
            const body = await res.text();
            if (!res.ok) {
              return { content: [{ type: 'text', text: `IRC bridge ${res.status}: ${body}` }] };
            }
            return { content: [{ type: 'text', text: `IRC: ${args.line}` }] };
          } catch (err) {
            return { content: [{ type: 'text', text: `IRC bridge unreachable: ${(err as Error).message}` }] };
          }
        },
      ),
    ],
  });
}
