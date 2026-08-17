import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { autoresearch } from '../workflows.js';
import { experimentSteerSignal } from '../signals.js';
import type { ProposeCandidateReq, MeasureCandidateReq } from '../activities.js';

const workflowsPath = fileURLToPath(new URL('../workflows.ts', import.meta.url));

let testEnv: TestWorkflowEnvironment;

beforeAll(async () => {
  const executablePath = process.env.TEMPORAL_CLI_PATH;
  testEnv = await TestWorkflowEnvironment.createLocal(
    executablePath
      ? { server: { executable: { type: 'existing-path', path: executablePath } } }
      : undefined,
  );
});

afterAll(async () => {
  await testEnv?.teardown();
});

describe('autoresearch workflow', () => {
  it('iterates propose → measure → record until the model stops', async () => {
    const recorded: any[] = [];
    const said: string[] = [];
    let best: number | null = null;
    let call = 0;

    const activities = {
      proposeCandidate: async (_req: ProposeCandidateReq) => {
        call++;
        if (call === 1) {
          return { stop: false, description: 'baseline impl', code: 'const f=1', bestValue: best };
        }
        if (call === 2) {
          return { stop: false, description: 'faster impl', code: 'const f=2', bestValue: best };
        }
        return { stop: true, reason: 'converged', description: '', code: '', bestValue: best };
      },
      measureCandidate: async (_req: MeasureCandidateReq) => {
        // First candidate measures 100, second measures 80 (a keep).
        return call === 1
          ? { values: [100, 100, 100], lastOutput: '' }
          : { values: [80, 80, 80], lastOutput: '' };
      },
      recordExperimentRun: async (req: any) => {
        recorded.push(req);
        if (req.verdict === 'keep' || req.verdict === 'baseline') best = req.value;
      },
      finishExperiment: async () => {},
      ircSay: async (req: { channel: string; text: string }) => {
        said.push(req.text);
      },
    };

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-auto',
      workflowsPath,
      activities,
    });

    await worker.runUntil(async () => {
      const name = `exp-${randomUUID().slice(0, 8)}`;
      const handle = await testEnv.client.workflow.start(autoresearch, {
        workflowId: `auto:${name}`,
        taskQueue: 'test-auto',
        args: [name, 'user-1', `#auto-${name}`, 'min', 'ms'],
      });
      await handle.result();
    });

    expect(recorded.map((r) => r.verdict)).toEqual(['baseline', 'keep']);
    expect(recorded[1].value).toBe(80);
    // Two iteration lines + a completion line.
    expect(said.some((s) => s.includes('#1 baseline'))).toBe(true);
    expect(said.some((s) => s.includes('#2 keep'))).toBe(true);
    expect(said.some((s) => s.includes('completed'))).toBe(true);
  });

  it('stops when steered with "stop"', async () => {
    let proposals = 0;
    const activities = {
      proposeCandidate: async () => {
        proposals++;
        // Slow proposal so the signal lands mid-loop.
        await new Promise((r) => setTimeout(r, 300));
        return { stop: false, description: `idea ${proposals}`, code: 'x', bestValue: null };
      },
      measureCandidate: async () => ({ values: [50, 50, 50], lastOutput: '' }),
      recordExperimentRun: async () => {},
      finishExperiment: async (req: any) => {
        expect(req.status).toBe('stopped');
      },
      ircSay: async () => {},
    };

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-auto',
      workflowsPath,
      activities,
    });

    await worker.runUntil(async () => {
      const name = `exp-${randomUUID().slice(0, 8)}`;
      const handle = await testEnv.client.workflow.start(autoresearch, {
        workflowId: `auto:${name}`,
        taskQueue: 'test-auto',
        args: [name, 'user-1', `#auto-${name}`, 'min', 'ms'],
      });
      await new Promise((r) => setTimeout(r, 100));
      await handle.signal(experimentSteerSignal, 'yournick: stop');
      await handle.result();
    });

    expect(proposals).toBeLessThan(5);
  });
});
