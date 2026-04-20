import Anthropic from '@anthropic-ai/sdk';
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import { heartbeat } from '@temporalio/activity';
import { publishDelta } from './publish.js';
import type { StreamReq } from './types.js';

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
  const blocks = final.content as Array<{ type: string; text?: string }>;
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}
