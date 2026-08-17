import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chatSession } from '../workflows.js';
import {
  userMessageSignal,
  closeSignal,
  transcriptQuery,
  cancelTurnSignal,
} from '../signals.js';
import type { LlmTurnReq, ExecuteToolReq } from '../activities.js';

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

function assistantMessage(text: string, toolCalls: Array<{ id: string; name: string; args: any }> = []) {
  return {
    role: 'assistant' as const,
    content: [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...toolCalls.map((tc) => ({
        type: 'toolCall' as const,
        id: tc.id,
        name: tc.name,
        arguments: tc.args,
      })),
    ],
    api: 'openai-completions',
    provider: 'openrouter',
    model: 'test-model',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: toolCalls.length > 0 ? 'toolUse' : 'stop',
    timestamp: Date.now(),
  };
}

const noopActivities = {
  persistTurn: async () => {},
  generateTitle: async () => {},
  endTurn: async () => {},
};

describe('chatSession workflow', () => {
  it('processes a single message and closes', async () => {
    // Fake llmTurn that echoes the last user turn, no tool calls.
    const fakeLlmTurn = async (req: LlmTurnReq) => {
      const last = req.convo[req.convo.length - 1] as any;
      return assistantMessage(`echo: ${last.content}`);
    };

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-chat',
      workflowsPath: workflowsPath,
      activities: {
        ...noopActivities,
        llmTurn: fakeLlmTurn,
        executeTool: async () => { throw new Error('no tools expected'); },
      },
    });

    await worker.runUntil(async () => {
      const sessionId = randomUUID();
      const handle = await testEnv.client.workflow.start(chatSession, {
        workflowId: `chat2:${sessionId}`,
        taskQueue: 'test-chat',
        args: [sessionId, []],
      });

      await handle.signal(userMessageSignal, 'hello');
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

  it('runs tool calls as activities and feeds results back', async () => {
    const toolCallsSeen: string[] = [];

    // First LLM call requests a tool; second call answers using the result.
    const fakeLlmTurn = async (req: LlmTurnReq) => {
      const last = req.convo[req.convo.length - 1] as any;
      if (last.role === 'toolResult') {
        return assistantMessage(`tool said: ${last.content[0].text}`);
      }
      return assistantMessage('', [{ id: 'tc-1', name: 'run_js', args: { code: '1+1' } }]);
    };

    const fakeExecuteTool = async (req: ExecuteToolReq) => {
      toolCallsSeen.push(req.toolName);
      return {
        role: 'toolResult' as const,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        content: [{ type: 'text' as const, text: '2' }],
        isError: false,
        timestamp: Date.now(),
      };
    };

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-chat',
      workflowsPath: workflowsPath,
      activities: {
        ...noopActivities,
        llmTurn: fakeLlmTurn,
        executeTool: fakeExecuteTool,
      },
    });

    await worker.runUntil(async () => {
      const sessionId = randomUUID();
      const handle = await testEnv.client.workflow.start(chatSession, {
        workflowId: `chat2:${sessionId}`,
        taskQueue: 'test-chat',
        args: [sessionId, []],
      });

      await handle.signal(userMessageSignal, 'what is 1+1?');
      let transcript: { role: string; content: string }[] = [];
      for (let i = 0; i < 50; i++) {
        transcript = await handle.query(transcriptQuery);
        if (transcript.some((m) => m.role === 'assistant')) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(toolCallsSeen).toEqual(['run_js']);
      expect(transcript).toEqual([
        { role: 'user', content: 'what is 1+1?' },
        { role: 'assistant', content: 'tool said: 2' },
      ]);

      await handle.signal(closeSignal);
      await handle.result();
    });
  });

  it('cancelTurn signal force-stops a tool loop', async () => {
    // llmTurn always requests another tool call — an endless loop unless
    // cancelled.
    let calls = 0;
    const activities = {
      ...noopActivities,
      llmTurn: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 100));
        return assistantMessage('', [{ id: `tc-${calls}`, name: 'run_js', args: {} }]);
      },
      executeTool: async (req: ExecuteToolReq) => ({
        role: 'toolResult' as const,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        content: [{ type: 'text' as const, text: 'ok' }],
        isError: false,
        timestamp: Date.now(),
      }),
    };

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-chat',
      workflowsPath: workflowsPath,
      activities,
    });

    await worker.runUntil(async () => {
      const sessionId = randomUUID();
      const handle = await testEnv.client.workflow.start(chatSession, {
        workflowId: `chat2:${sessionId}`,
        taskQueue: 'test-chat',
        args: [sessionId, []],
      });

      await handle.signal(userMessageSignal, 'go');
      await new Promise((r) => setTimeout(r, 400));
      await handle.signal(cancelTurnSignal);

      let transcript: { role: string; content: string }[] = [];
      for (let i = 0; i < 100; i++) {
        transcript = await handle.query(transcriptQuery);
        if (transcript.some((m) => m.role === 'assistant')) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(transcript.at(-1)).toEqual({
        role: 'assistant',
        content: '[turn cancelled by operator]',
      });
      expect(calls).toBeLessThan(20);

      await handle.signal(closeSignal);
      await handle.result();
    });
  });

  it('coalesces messages queued during a generation into one next turn', async () => {
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((r) => { releaseFirst = r; });
    let callCount = 0;

    const fakeLlmTurn = async (req: LlmTurnReq) => {
      callCount++;
      if (callCount === 1) {
        await firstDone;
        return assistantMessage('first-reply');
      }
      const last = req.convo[req.convo.length - 1] as any;
      return assistantMessage(`reply-to: ${last.content}`);
    };

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-chat',
      workflowsPath: workflowsPath,
      activities: {
        ...noopActivities,
        llmTurn: fakeLlmTurn,
        executeTool: async () => { throw new Error('no tools expected'); },
      },
    });

    await worker.runUntil(async () => {
      const sessionId = randomUUID();
      const handle = await testEnv.client.workflow.start(chatSession, {
        workflowId: `chat2:${sessionId}`,
        taskQueue: 'test-chat',
        args: [sessionId, []],
      });

      await handle.signal(userMessageSignal, 'msg-1');
      await new Promise((r) => setTimeout(r, 200));
      await handle.signal(userMessageSignal, 'msg-2');
      await handle.signal(userMessageSignal, 'msg-3');
      releaseFirst();

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
