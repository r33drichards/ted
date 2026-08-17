import { Client, Connection } from '@temporalio/client';

let clientPromise: Promise<Client> | null = null;

/** Lazy singleton Temporal client for use from activities/tools. */
export function getTemporalClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const connection = await Connection.connect({
        address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
      });
      return new Client({
        connection,
        namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
      });
    })();
    clientPromise.catch(() => {
      clientPromise = null;
    });
  }
  return clientPromise;
}

export const TASK_QUEUE = process.env.TASK_QUEUE ?? 'chat';
