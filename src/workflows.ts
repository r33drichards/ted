import {
  proxyActivities,
  setHandler,
  condition,
  continueAsNew,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from './activities.js';
import { userMessageSignal, closeSignal, transcriptQuery } from './signals.js';
import { drainInbox } from './inbox.js';
import type { Msg } from './types.js';

const { streamClaude, persistTurn, generateTitle } = proxyActivities<
  typeof activities
>({
  startToCloseTimeout: '10 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

const { deliverScheduledPrompt } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 },
});

const HISTORY_LENGTH_LIMIT = 2000;

export async function chatSession(
  sessionId: string,
  seedHistory: Msg[] = [],
  userId: string = '',
): Promise<void> {
  const inbox: string[] = [];
  const history: Msg[] = [...seedHistory];
  let closed = false;
  // Only trigger auto-title for the first real turn of a *fresh* session,
  // not after a continue-as-new or when resuming with a seed history.
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
    }

    const text = await streamClaude({ sessionId, history, userId });
    history.push({ role: 'assistant', content: text });
    await persistTurn({ sessionId, role: 'assistant', content: text, userId });

    if (!titleGenerated && userTurn !== null) {
      titleGenerated = true;
      await generateTitle({ sessionId, userMessage: userTurn, userId });
    }

    if (workflowInfo().historyLength > HISTORY_LENGTH_LIMIT) {
      await continueAsNew<typeof chatSession>(sessionId, history, userId);
    }
  }
}

export type ScheduledPromptTickArgs = {
  promptId: string;
  userId: string;
  sessionId: string;
  prompt: string;
};

/**
 * Tick workflow launched by a Temporal Schedule. Single-shot: just hands
 * off to the `deliverScheduledPrompt` activity which signals the chat
 * session. Keeps the Schedule → Workflow → Activity chain idiomatic.
 */
export async function scheduledPromptTick(
  args: ScheduledPromptTickArgs,
): Promise<void> {
  await deliverScheduledPrompt(args);
}
