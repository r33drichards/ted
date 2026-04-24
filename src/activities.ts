import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { heartbeat } from '@temporalio/activity';
import { publishDelta, publishThinking, publishToolCall, publishTurnEnd } from './publish.js';
import {
  appendMessage,
  touchSession,
  renameSession,
  loadMemoryContext,
  listEnabledMcpServers,
} from './db.js';
import { createTedMcpServer } from './memory-mcp.js';
import type { Role, StreamReq } from './types.js';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5';

/**
 * Stream an assistant turn using the Claude Agent SDK.
 *
 * Uses SDK session `resume` for multi-turn context — each turn resumes
 * the previous session so the agent has full conversation history without
 * us passing it manually.
 *
 * Returns { text, sdkSessionId } so the workflow can track the session.
 */
export async function streamClaude(req: StreamReq): Promise<{ text: string; sdkSessionId: string }> {
  const memoryCtx = await loadMemoryContext(req.userId);
  const tedServer = createTedMcpServer(req.userId);

  // Build MCP servers from user's DB config
  const dbServers = await listEnabledMcpServers(req.userId);
  const userMcpServers: Record<string, any> = {};
  for (const s of dbServers) {
    if (s.transport === 'stdio' && s.command) {
      userMcpServers[s.name] = { command: s.command, args: s.args ?? [] };
    } else if (s.url) {
      userMcpServers[s.name] = { type: 'http', url: s.url };
    }
  }

  const PLUGIN_DIR = '/app/ted-plugin';
  const SKILLS_DIR = `${PLUGIN_DIR}/skills`;

  const systemParts: string[] = [
    `You can create and edit your own skills by writing SKILL.md files under ${SKILLS_DIR}/. ` +
    'Each skill goes in its own subdirectory (e.g. skills/dice/SKILL.md). ' +
    'Use the Write or Edit tools directly — no permission needed. ' +
    'You can also add and remove MCP tool servers using mcp__ted__mcp_add, mcp__ted__mcp_list, mcp__ted__mcp_remove. ' +
    'New servers become available on the next turn.',
  ];
  if (memoryCtx) systemParts.push(memoryCtx);

  const lastUserMsg = req.history.filter((m) => m.role === 'user').pop();
  const prompt = lastUserMsg?.content ?? '';

  const options: Options = {
    model: MODEL,
    cwd: '/app',
    additionalDirectories: [SKILLS_DIR],
    ...(process.env.CLAUDE_CODE_PATH ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_PATH } : {}),
    systemPrompt: systemParts.join('\n\n'),
    plugins: [{ type: 'local', path: PLUGIN_DIR }],
    allowedTools: [
      'Read', 'Write', 'Edit',
      'Glob', 'Grep',
      'WebSearch', 'WebFetch',
      'Skill', 'Agent',
      'mcp__*',
    ],
    disallowedTools: ['Bash', 'Monitor'],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project'],
    includePartialMessages: true,
    mcpServers: {
      ted: tedServer,
      ...userMcpServers,
    },
    // Resume previous SDK session for multi-turn context
    ...(req.sdkSessionId ? { resume: req.sdkSessionId } : {}),
  };

  let lastAssistantText = '';
  let sdkSessionId = req.sdkSessionId ?? '';

  // If resume fails (stale session), retry without resume
  async function* runQuery() {
    try {
      yield* query({ prompt, options });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('No conversation found') && options.resume) {
        console.log(`[agent] stale session ${options.resume}, starting fresh`);
        delete options.resume;
        sdkSessionId = '';
        yield* query({ prompt, options });
      } else {
        throw err;
      }
    }
  }

  try {
    for await (const message of runQuery()) {
      heartbeat();

      // Capture session ID from init message
      if (message.type === 'system' && (message as any).subtype === 'init') {
        sdkSessionId = (message as any).session_id ?? sdkSessionId;
      }

      // Streaming events (token by token)
      if (message.type === 'stream_event' && (message as any).event) {
        const ev = (message as any).event;
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

      // Complete assistant messages
      if (message.type === 'assistant') {
        const msg = (message as any).message;
        if (msg?.content) {
          const textParts = (msg.content as any[])
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '');
          if (textParts.length > 0) {
            lastAssistantText = textParts.join('');
          }
        }
      }

      // Result — agent finished this turn
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

  return { text: lastAssistantText, sdkSessionId };
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
        ...(process.env.CLAUDE_CODE_PATH ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_PATH } : {}),
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
    // Best-effort
  }
}
