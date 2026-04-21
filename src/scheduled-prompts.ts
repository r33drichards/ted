import type { Client } from '@temporalio/client';
import { ScheduleOverlapPolicy } from '@temporalio/client';
import { chatSession } from './workflows.js';
import { userMessageSignal } from './signals.js';
import {
  createSession as dbCreateSession,
  sessionBelongsTo,
  markScheduledPromptRan,
} from './db.js';

/**
 * Compose the Temporal Schedule id for a scheduled prompt row.
 * Keeping it derived from the DB id means we can reconstruct the handle
 * at any time without needing a second source of truth.
 */
export function scheduleIdFor(promptId: string): string {
  return `scheduled-prompt:${promptId}`;
}

export type UpsertScheduleInput = {
  promptId: string;
  userId: string;
  sessionId: string;
  prompt: string;
  intervalSeconds: number;
  enabled: boolean;
  taskQueue: string;
};

/**
 * Create the Temporal Schedule that periodically kicks off a
 * `scheduledPromptTick` workflow, which in turn signals the target chat
 * session. If a schedule with this id already exists (e.g. the DB and
 * Temporal have drifted), update it in place.
 */
export async function upsertSchedule(
  client: Client,
  input: UpsertScheduleInput,
): Promise<void> {
  const scheduleId = scheduleIdFor(input.promptId);
  const action = {
    type: 'startWorkflow' as const,
    workflowType: 'scheduledPromptTick',
    taskQueue: input.taskQueue,
    args: [
      {
        promptId: input.promptId,
        userId: input.userId,
        sessionId: input.sessionId,
        prompt: input.prompt,
      },
    ] as [ScheduledPromptTickInput],
  };

  try {
    await client.schedule.create({
      scheduleId,
      spec: { intervals: [{ every: `${input.intervalSeconds}s` }] },
      action,
      policies: { overlap: ScheduleOverlapPolicy.SKIP },
      state: { paused: !input.enabled },
    });
  } catch (err) {
    // AlreadyExists -> update path.
    if (isAlreadyExists(err)) {
      const handle = client.schedule.getHandle(scheduleId);
      await handle.update(() => ({
        spec: { intervals: [{ every: `${input.intervalSeconds}s` }] },
        action,
        policies: { overlap: ScheduleOverlapPolicy.SKIP },
        state: { paused: !input.enabled },
      }));
      return;
    }
    throw err;
  }
}

export async function deleteSchedule(
  client: Client,
  promptId: string,
): Promise<void> {
  try {
    await client.schedule.getHandle(scheduleIdFor(promptId)).delete();
  } catch (err) {
    // NotFound is fine — delete is idempotent.
    if (isNotFound(err)) return;
    throw err;
  }
}

export async function pauseSchedule(
  client: Client,
  promptId: string,
  paused: boolean,
): Promise<void> {
  const handle = client.schedule.getHandle(scheduleIdFor(promptId));
  if (paused) {
    await handle.pause('disabled via ted UI');
  } else {
    await handle.unpause('enabled via ted UI');
  }
}

function isAlreadyExists(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? '';
  return name === 'ScheduleAlreadyRunning' || name.includes('AlreadyExists');
}

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? '';
  return name === 'NotFoundError' || name.includes('NotFound');
}

export type ScheduledPromptTickInput = {
  promptId: string;
  userId: string;
  sessionId: string;
  prompt: string;
};

/**
 * Activity: signal the chat workflow for `sessionId` with `prompt`,
 * starting it (and creating the DB session row) if needed. Mirrors the
 * HTTP POST /message flow so behaviour stays consistent.
 */
export async function deliverScheduledPrompt(
  input: ScheduledPromptTickInput,
  deps: {
    signalWithStart: (args: {
      workflowId: string;
      taskQueue: string;
      userId: string;
      sessionId: string;
      prompt: string;
    }) => Promise<void>;
    taskQueue: string;
  },
): Promise<void> {
  const exists = await sessionBelongsTo(input.sessionId, input.userId);
  if (!exists) {
    await dbCreateSession(input.userId, input.sessionId, null);
  }
  await deps.signalWithStart({
    workflowId: `chat:${input.sessionId}`,
    taskQueue: deps.taskQueue,
    userId: input.userId,
    sessionId: input.sessionId,
    prompt: input.prompt,
  });
  await markScheduledPromptRan(input.promptId, input.userId);
}

/**
 * Factory the activity layer in src/activities.ts calls once on startup
 * to wire the dependencies in. Keeps activities.ts free of Temporal
 * Client plumbing.
 */
export function makeDeliverScheduledPrompt(client: Client, taskQueue: string) {
  return async function (input: ScheduledPromptTickInput): Promise<void> {
    await deliverScheduledPrompt(input, {
      taskQueue,
      signalWithStart: async ({ workflowId, taskQueue, sessionId, userId, prompt }) => {
        await client.workflow.signalWithStart(chatSession, {
          workflowId,
          taskQueue,
          args: [sessionId, [], userId],
          signal: userMessageSignal,
          signalArgs: [prompt],
        });
      },
    });
  };
}
