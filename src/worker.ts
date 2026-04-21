import { Worker, NativeConnection } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import * as activities from './activities.js';
import { chatSession } from './workflows.js';
import { userMessageSignal } from './signals.js';
import { ensureSchema } from './db.js';

async function main() {
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
  const taskQueue = process.env.TASK_QUEUE ?? 'chat';

  await ensureSchema();

  const connection = await NativeConnection.connect({ address });
  const clientConnection = await Connection.connect({ address });
  const client = new Client({ connection: clientConnection, namespace });

  activities.initDeliverScheduledPrompt({
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

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    workflowsPath: new URL('./workflows.ts', import.meta.url).pathname,
    activities,
  });

  console.log(`Worker listening on task queue "${taskQueue}" at ${address}`);
  await worker.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
