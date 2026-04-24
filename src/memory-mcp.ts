/**
 * In-process MCP server exposing the memory CRUD as tools.
 * Passed to the Agent SDK via `mcpServers` so the agent can
 * manage memories without custom built-in tools.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import {
  setMemory,
  getMemory,
  deleteMemory,
  listMemories,
  searchMemories,
  type MemoryTier,
} from './db.js';

const tierEnum = z.enum(['working', 'short_term', 'long_term']);

export function createMemoryMcpServer(userId: string) {
  return createSdkMcpServer({
    name: 'memory',
    version: '1.0.0',
    tools: [
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
    ],
  });
}
