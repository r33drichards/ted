import Anthropic from '@anthropic-ai/sdk';
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import { heartbeat } from '@temporalio/activity';
import { publishDelta, publishTurnEnd } from './publish.js';
import {
  appendMessage,
  touchSession,
  renameSession,
  listEnabledMcpServers,
  type McpServerRow,
} from './db.js';
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
const MAX_TOKENS = 4096;

const MCP_BETA = 'mcp-client-2025-04-04';

export type McpServerParam = {
  type: 'url';
  url: string;
  name: string;
  tool_configuration?: { allowed_tools: string[] };
};

export function buildMcpServersParam(
  rows: McpServerRow[],
): McpServerParam[] {
  return rows.map((r) => ({
    type: 'url' as const,
    url: r.url,
    name: r.name,
    ...(r.allowed_tools.length > 0
      ? { tool_configuration: { allowed_tools: r.allowed_tools } }
      : {}),
  }));
}

export async function streamClaude(req: StreamReq): Promise<string> {
  const mcpServers = useBedrock
    ? []
    : buildMcpServersParam(await listEnabledMcpServers(req.userId));

  const params: Record<string, unknown> = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: req.history,
  };
  const options: { headers?: Record<string, string> } = {};
  if (mcpServers.length > 0) {
    params.mcp_servers = mcpServers;
    options.headers = { 'anthropic-beta': MCP_BETA };
  }

  // The stable SDK types don't yet know about `mcp_servers`; the beta header
  // enables it on the wire. `client` is a union of Anthropic + Bedrock SDK
  // instances with separate nominal types for params, so a shared cast can't
  // narrow both — use `any` and rely on the wire format.
  const stream = (client.messages as unknown as {
    stream: (
      p: unknown,
      o?: unknown,
    ) => ReturnType<typeof client.messages.stream>;
  }).stream(params, options);

  try {
    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        await publishDelta(req.sessionId, event.delta.text);
        heartbeat();
      }
    }

    const final = await stream.finalMessage();
    // Cast to a loose shape — the Bedrock SDK's ContentBlock union is a
    // separate nominal type from the Anthropic SDK's, so a shared filter can't
    // narrow both at once.
    const blocks = final.content as Array<{ type: string; text?: string }>;
    return blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
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
    // Cast through any: Bedrock and base Anthropic SDKs diverge on union
    // callable typing. Same pattern as streamClaude's content extraction.
    const resp = await (client.messages.create as (args: unknown) => Promise<unknown>)({
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
    }) as { content: Array<{ type: string; text?: string }> };
    const blocks = resp.content;
    let title = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
      .trim();
    // Strip common model habits: surrounding quotes, trailing period.
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
