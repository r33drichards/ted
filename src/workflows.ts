import {
  proxyActivities,
  setHandler,
  condition,
  continueAsNew,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from './activities.js';
import type { Message, ToolCall } from '@earendil-works/pi-ai';
import { userMessageSignal, closeSignal, transcriptQuery } from './signals.js';
import { drainInbox } from './inbox.js';
import type { Msg } from './types.js';

const { llmTurn, persistTurn, generateTitle } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  heartbeatTimeout: '60 seconds',
  retry: { maximumAttempts: 3 },
});

// Tool executions get their own activity config: no heartbeat requirement,
// shorter timeout, fewer retries (tools may not be idempotent).
const { executeTool, endTurn } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 2 },
});

const HISTORY_LENGTH_LIMIT = 2000;
const MAX_TOOL_ITERATIONS = 40;
const CONVO_MAX_MESSAGES = 120;
const CONVO_MAX_CHARS = 300_000;

function extractText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b.text ?? '')
    .join('');
}

/**
 * Trim the LLM conversation from the front so payloads stay well under
 * Temporal's size limits. Always cuts at a user-message boundary so no
 * toolResult is orphaned from the assistant message that requested it.
 */
function trimConvo(convo: Message[]): void {
  const tooBig = () =>
    convo.length > CONVO_MAX_MESSAGES || JSON.stringify(convo).length > CONVO_MAX_CHARS;
  while (tooBig() && convo.length > 20) {
    convo.shift();
    while (convo.length > 0 && convo[0].role !== 'user') convo.shift();
  }
}

export async function chatSession(
  sessionId: string,
  seedHistory: Msg[] = [],
  userId: string = '',
  seedConvo: Message[] = [],
): Promise<void> {
  const inbox: string[] = [];
  const history: Msg[] = [...seedHistory];
  // Full LLM conversation (user turns, assistant turns incl. tool calls,
  // tool results) — the durable agent-loop state.
  const convo: Message[] = [...seedConvo];
  let closed = false;
  let titleGenerated = seedHistory.length > 0;

  setHandler(userMessageSignal, (msg: string) => {
    inbox.push(msg);
  });
  setHandler(closeSignal, () => {
    closed = true;
  });
  setHandler(transcriptQuery, () => history);

  while (!closed) {
    await condition(() => inbox.length > 0 || closed);
    if (closed) break;

    const userTurn = drainInbox(inbox, history);
    if (userTurn !== null) {
      await persistTurn({ sessionId, role: 'user', content: userTurn, userId });
      convo.push({ role: 'user', content: userTurn, timestamp: Date.now() });
    }

    // Agent loop: each LLM call and each tool execution is an activity.
    let finalText = '';
    try {
      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        const assistant = await llmTurn({ sessionId, userId, convo });
        convo.push(assistant);

        const text = extractText(assistant.content);
        if (text.trim()) finalText = text;

        const toolCalls = (Array.isArray(assistant.content) ? assistant.content : []).filter(
          (b): b is ToolCall => (b as any)?.type === 'toolCall',
        );
        if (toolCalls.length === 0) break;

        const results = await Promise.all(
          toolCalls.map((tc) =>
            executeTool({
              sessionId,
              userId,
              toolCallId: tc.id,
              toolName: tc.name,
              args: tc.arguments ?? {},
            }),
          ),
        );
        convo.push(...results);
        trimConvo(convo);
      }
    } catch (err) {
      // Keep the session alive on a failed turn. Drop a trailing assistant
      // message whose tool calls never got results, so the next LLM call
      // doesn't see a dangling tool call.
      while (convo.length > 0) {
        const last = convo[convo.length - 1] as any;
        const dangling =
          last.role === 'assistant' &&
          Array.isArray(last.content) &&
          last.content.some((b: any) => b?.type === 'toolCall');
        if (!dangling) break;
        convo.pop();
      }
      finalText = `[error] turn failed: ${(err as Error).message}`;
    } finally {
      await endTurn({ sessionId });
    }

    history.push({ role: 'assistant', content: finalText });
    await persistTurn({ sessionId, role: 'assistant', content: finalText, userId });
    trimConvo(convo);

    if (!titleGenerated && userTurn !== null) {
      titleGenerated = true;
      await generateTitle({ sessionId, userMessage: userTurn, userId });
    }

    if (workflowInfo().historyLength > HISTORY_LENGTH_LIMIT) {
      await continueAsNew<typeof chatSession>(sessionId, history, userId, convo);
    }
  }
}
