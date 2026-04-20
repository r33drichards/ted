import Anthropic from '@anthropic-ai/sdk';
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import { heartbeat } from '@temporalio/activity';
import { publishDelta, publishTurnEnd } from './publish.js';
import { appendMessage, touchSession } from './db.js';
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

export async function streamClaude(req: StreamReq): Promise<string> {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: req.history,
  });

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
