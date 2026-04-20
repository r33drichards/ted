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

const { streamClaude, persistTurn } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  heartbeatTimeout: '30 seconds',
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

    const text = await streamClaude({ sessionId, history });
    history.push({ role: 'assistant', content: text });
    await persistTurn({ sessionId, role: 'assistant', content: text, userId });

    if (workflowInfo().historyLength > HISTORY_LENGTH_LIMIT) {
      await continueAsNew<typeof chatSession>(sessionId, history, userId);
    }
  }
}
