import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chatSession } from '../workflows.js';
import { userMessageSignal, closeSignal, transcriptQuery } from '../signals.js';
import type { StreamReq } from '../types.js';

const workflowsPath = fileURLToPath(new URL('../workflows.ts', import.meta.url));

let testEnv: TestWorkflowEnvironment;

beforeAll(async () => {
  const executablePath = process.env.TEMPORAL_CLI_PATH;
  testEnv = await TestWorkflowEnvironment.createLocal(
    executablePath
      ? {
          server: {
            executable: { type: 'existing-path', path: executablePath },
          },
        }
      : undefined,
  );
});

afterAll(async () => {
  await testEnv?.teardown();
});

describe('chatSession workflow', () => {
  it('processes a single message and closes', async () => {
    // Fake activity that echoes the last user turn.
    const fakeStreamClaude = async (req: StreamReq): Promise<string> => {
      const last = req.history[req.history.length - 1];
      return `echo: ${last.content}`;
    };

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-chat',
      workflowsPath: workflowsPath,
      activities: { streamClaude: fakeStreamClaude, persistTurn: async () => {} },
    });

    await worker.runUntil(async () => {
      const sessionId = randomUUID();
      const handle = await testEnv.client.workflow.start(chatSession, {
        workflowId: `chat:${sessionId}`,
        taskQueue: 'test-chat',
        args: [sessionId, []],
      });

      await handle.signal(userMessageSignal, 'hello');
      // Poll transcript until assistant reply appears
      let transcript: { role: string; content: string }[] = [];
      for (let i = 0; i < 50; i++) {
        transcript = await handle.query(transcriptQuery);
        if (transcript.some((m) => m.role === 'assistant')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(transcript).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'echo: hello' },
      ]);

      await handle.signal(closeSignal);
      await handle.result();
    });
  });

  it('coalesces messages queued during a generation into one next turn', async () => {
    // Activity that holds open until released, so we can signal mid-flight.
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((r) => { releaseFirst = r; });
    let callCount = 0;

    const fakeStreamClaude = async (req: StreamReq): Promise<string> => {
      callCount++;
      if (callCount === 1) {
        await firstDone;
        return 'first-reply';
      }
      const last = req.history[req.history.length - 1];
      return `reply-to: ${last.content}`;
    };

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-chat',
      workflowsPath: workflowsPath,
      activities: { streamClaude: fakeStreamClaude, persistTurn: async () => {} },
    });

    await worker.runUntil(async () => {
      const sessionId = randomUUID();
      const handle = await testEnv.client.workflow.start(chatSession, {
        workflowId: `chat:${sessionId}`,
        taskQueue: 'test-chat',
        args: [sessionId, []],
      });

      await handle.signal(userMessageSignal, 'msg-1');
      // Wait a beat so the workflow enters streamClaude
      await new Promise((r) => setTimeout(r, 200));
      // Queue two more while first generation is in flight
      await handle.signal(userMessageSignal, 'msg-2');
      await handle.signal(userMessageSignal, 'msg-3');
      // Release the first generation
      releaseFirst();

      // Wait for second generation to complete
      let transcript: { role: string; content: string }[] = [];
      for (let i = 0; i < 100; i++) {
        transcript = await handle.query(transcriptQuery);
        if (transcript.filter((m) => m.role === 'assistant').length >= 2) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(transcript).toEqual([
        { role: 'user', content: 'msg-1' },
        { role: 'assistant', content: 'first-reply' },
        { role: 'user', content: 'msg-2\n\nmsg-3' },
        { role: 'assistant', content: 'reply-to: msg-2\n\nmsg-3' },
      ]);

      await handle.signal(closeSignal);
      await handle.result();
    });
  });
});
