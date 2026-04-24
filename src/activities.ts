import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { heartbeat } from '@temporalio/activity';
import { publishDelta, publishThinking, publishToolCall, publishTurnEnd } from './publish.js';
import {
  appendMessage,
  touchSession,
  renameSession,
  listEnabledMcpServers,
  loadMemoryContext,
} from './db.js';
import { createMemoryMcpServer } from './memory-mcp.js';
import type { Role, StreamReq } from './types.js';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5';

/**
 * Build MCP server configs from the user's enabled servers in the DB.
 * Returns a record suitable for the Agent SDK's `mcpServers` option.
 */
async function buildMcpServers(userId: string): Promise<Record<string, any>> {
  const servers = await listEnabledMcpServers(userId);
  const config: Record<string, any> = {};
  for (const s of servers) {
    if (s.transport === 'stdio' && s.command) {
      config[s.name] = { command: s.command, args: s.args ?? [] };
    } else if (s.url) {
      // Detect SSE vs HTTP based on URL patterns, default to HTTP
      config[s.name] = { type: 'http', url: s.url };
    }
  }
  return config;
}

/**
 * Stream an assistant turn using the Claude Agent SDK.
 *
 * The SDK handles the full agent loop: tool execution, MCP dispatch,
 * skills, subagents, etc. We stream events to Redis for the IRC bridge
 * and persist the final text.
 */
export async function streamClaude(req: StreamReq): Promise<string> {
  // Load user memories for system prompt injection
  const memoryCtx = await loadMemoryContext(req.userId);
  const userMcpServers = await buildMcpServers(req.userId);

  // Build the prompt from history
  const historyLines = req.history.map(
    (m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`,
  );
  // The last user message is the prompt; prior history goes into context
  const lastUserMsg = req.history.filter((m) => m.role === 'user').pop();
  const prompt = lastUserMsg?.content ?? '';

  const systemParts: string[] = [
    'You have full read/write access to .claude/skills/. ' +
    'You can create, edit, and delete skill files there without asking for permission. ' +
    'Just do it directly using Write or Edit tools.',
  ];
  if (req.systemPrompt) systemParts.push(req.systemPrompt);
  if (memoryCtx) systemParts.push(memoryCtx);
  // Include prior conversation as context
  if (req.history.length > 1) {
    systemParts.push(
      '[Conversation history]\n' +
      req.history.slice(0, -1).map(
        (m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`,
      ).join('\n'),
    );
  }

  const systemPrompt = systemParts.join('\n\n') || undefined;

  // Create in-process memory MCP server for this user
  const memoryServer = createMemoryMcpServer(req.userId);

  // Sandbox filesystem tools to .claude/skills/ only
  const fsGuard = async (input: Record<string, unknown>) => {
    // The hook input structure varies — extract any path-like field
    const inp = input as any;
    const filePath = String(
      inp.tool_input?.file_path ??
      inp.tool_input?.path ??
      inp.tool_input?.pattern ??
      inp.file_path ??
      inp.path ??
      inp.pattern ??
      '',
    );
    // Allow if no path (e.g. Glob with no path defaults to cwd) or path is under skills
    if (!filePath || filePath.includes('.claude/skills')) {
      return {};
    }
    return { decision: 'block' as const, reason: 'Filesystem access restricted to .claude/skills/' };
  };

  const options: Options = {
    model: MODEL,
    cwd: '/app',
    ...(process.env.CLAUDE_CODE_PATH ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_PATH } : {}),
    systemPrompt,
    allowedTools: [
      'Read', 'Write', 'Edit',
      'Glob', 'Grep',
      'WebSearch', 'WebFetch',
      'Skill', 'Agent',
      'mcp__*',
    ],
    disallowedTools: ['Bash', 'Monitor'],
    permissionMode: 'dontAsk',
    settingSources: ['project'],
    includePartialMessages: true,
    persistSession: false,
    hooks: {
      PreToolUse: [{
        matcher: 'Read|Write|Edit|Glob|Grep',
        hooks: [fsGuard],
      }],
    },
    mcpServers: {
      ...userMcpServers,
      memory: memoryServer,
    },
  };

  let lastAssistantText = '';

  try {
    for await (const message of query({ prompt, options })) {
      heartbeat();

      // Partial streaming events (token-by-token)
      if (message.type === 'stream_event' && message.event) {
        const ev = message.event as any;
        if (ev.type === 'content_block_delta') {
          if (ev.delta?.type === 'text_delta' && ev.delta.text) {
            await publishDelta(req.sessionId, ev.delta.text);
          } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
            await publishThinking(req.sessionId, ev.delta.thinking);
          }
        } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
          await publishToolCall(req.sessionId, ev.content_block.name ?? 'unknown');
        }
      }

      // Complete assistant messages (for extracting final text)
      if (message.type === 'assistant') {
        const msg = (message as any).message;
        if (msg?.content) {
          const textParts = msg.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text ?? '');
          if (textParts.length > 0) {
            lastAssistantText = textParts.join('');
          }
        }
      }

      // Result message — agent finished
      if (message.type === 'result') {
        const result = (message as any).result;
        if (typeof result === 'string' && result) {
          lastAssistantText = result;
        }
      }
    }
  } finally {
    await publishTurnEnd(req.sessionId);
  }

  return lastAssistantText;
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

const TITLE_MODEL = process.env.ANTHROPIC_TITLE_MODEL ?? 'claude-haiku-4-5';

export type GenerateTitleReq = {
  sessionId: string;
  userMessage: string;
  userId: string;
};

/**
 * Generate a short title for a session using the Agent SDK.
 */
export async function generateTitle(req: GenerateTitleReq): Promise<void> {
  try {
    let title = '';
    for await (const message of query({
      prompt:
        'Summarise the following message as a concise 3-6 word chat ' +
        'title. Reply with ONLY the title text, no quotes, no ' +
        "punctuation, no leading 'Title:'.\n\n" +
        req.userMessage,
      options: {
        model: TITLE_MODEL,
        tools: [],
        permissionMode: 'dontAsk',
        persistSession: false,
      },
    })) {
      if (message.type === 'result') {
        const result = (message as any).result;
        if (typeof result === 'string') title = result;
      }
    }
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
