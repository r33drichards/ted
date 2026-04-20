import Anthropic from '@anthropic-ai/sdk';
import { heartbeat } from '@temporalio/activity';
import { publishDelta, publishTurnEnd } from './publish.js';
import { appendMessage } from './db.js';
import type { Role, StreamReq } from './types.js';

const client = new Anthropic({ maxRetries: 0 }); // Temporal owns retries

const MODEL = 'claude-opus-4-5';
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
    return final.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } finally {
    await publishTurnEnd(req.sessionId);
  }
}

export type PersistTurnReq = {
  sessionId: string;
  role: Role;
  content: string;
};

export async function persistTurn(req: PersistTurnReq): Promise<void> {
  await appendMessage(req.sessionId, req.role, req.content);
}
