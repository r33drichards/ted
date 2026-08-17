import {
  proxyActivities,
  setHandler,
  condition,
  continueAsNew,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from './activities.js';
import type { Message, ToolCall } from '@earendil-works/pi-ai';
import {
  userMessageSignal,
  closeSignal,
  transcriptQuery,
  experimentSteerSignal,
} from './signals.js';
import { drainInbox } from './inbox.js';
import { decideVerdict, formatRunLine, type Direction } from './experiments.js';
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

// Autoresearch activities.
const { proposeCandidate, finishExperiment } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 3 },
});
const { measureCandidate } = proxyActivities<typeof activities>({
  startToCloseTimeout: '15 minutes',
  heartbeatTimeout: '3 minutes',
  retry: { maximumAttempts: 2 },
});
const { recordExperimentRun, ircSay } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 },
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

/* ------------------------------------------------------------------ */
/*  Autoresearch: autonomous experiment loop                          */
/* ------------------------------------------------------------------ */

const EXPERIMENT_MAX_ITERATIONS = 200;
const EXPERIMENT_CAN_INTERVAL = 25;
const EXPERIMENT_SAMPLES = 3;

/** Strip the `nick: ` prefix the bridge prepends to channel messages. */
function steerText(msg: string): string {
  return msg.replace(/^[^\s:]+:\s*/, '').trim();
}

/**
 * Autonomous optimization loop (pi-autoresearch pattern): propose a
 * candidate (LLM activity) → measure it in the mcp-js sandbox (activity)
 * → keep/discard vs the current best → log + report to the experiment's
 * IRC channel. Steered by messages in that channel (stop/pause/resume/
 * status are commands; anything else is guidance for the next proposal).
 */
export async function autoresearch(
  name: string,
  userId: string,
  channel: string,
  direction: Direction,
  metricUnit: string,
  startIteration: number = 0,
): Promise<void> {
  const steering: string[] = [];
  setHandler(experimentSteerSignal, (msg: string) => {
    steering.push(msg);
  });

  let iteration = startIteration;
  let paused = false;
  let stopped = false;
  let stopReason = '';
  let best: number | null = null;
  const guidance: string[] = [];

  while (!stopped && iteration < EXPERIMENT_MAX_ITERATIONS) {
    for (const raw of steering.splice(0)) {
      const text = steerText(raw);
      const cmd = text.toLowerCase();
      if (cmd === 'stop') {
        stopped = true;
        stopReason = 'stopped by operator';
      } else if (cmd === 'pause') {
        paused = true;
        await ircSay({ channel, text: `paused at #${iteration} — say "resume" to continue` });
      } else if (cmd === 'resume') {
        paused = false;
        await ircSay({ channel, text: `resuming at #${iteration}` });
      } else if (cmd === 'status') {
        await ircSay({
          channel,
          text: `iteration ${iteration}, best ${best ?? 'n/a'}${metricUnit}, ${paused ? 'paused' : 'running'}`,
        });
      } else if (text) {
        guidance.push(text);
        await ircSay({ channel, text: `noted — will apply to the next candidate` });
      }
    }
    if (stopped) break;
    if (paused) {
      await condition(() => steering.length > 0);
      continue;
    }

    const proposal = await proposeCandidate({ name, userId, guidance: guidance.splice(0) });
    best = proposal.bestValue;
    if (proposal.stop) {
      stopped = true;
      stopReason = proposal.reason || 'model concluded the search';
      break;
    }

    const measured = await measureCandidate({ name, code: proposal.code, samples: EXPERIMENT_SAMPLES });
    const { verdict, value } = decideVerdict(measured.values, best, direction);
    if (verdict === 'keep' || verdict === 'baseline') best = value;

    iteration++;
    await recordExperimentRun({
      name,
      iteration,
      description: proposal.description,
      code: proposal.code,
      samples: measured.values,
      value,
      verdict,
    });
    await ircSay({
      channel,
      text: formatRunLine(iteration, verdict, value, best, metricUnit, proposal.description),
    });

    if (iteration % EXPERIMENT_CAN_INTERVAL === 0 && iteration < EXPERIMENT_MAX_ITERATIONS) {
      await continueAsNew<typeof autoresearch>(name, userId, channel, direction, metricUnit, iteration);
    }
  }

  const status = stopReason.startsWith('stopped') ? 'stopped' : 'completed';
  await finishExperiment({ name, status });
  await ircSay({
    channel,
    text: `experiment "${name}" ${status} after ${iteration} iteration(s); best ${best ?? 'n/a'}${metricUnit}. ${stopReason}`,
  });
}
