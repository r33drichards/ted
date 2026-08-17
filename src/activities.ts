import { heartbeat } from '@temporalio/activity';
import { streamSimple, completeSimple } from '@earendil-works/pi-ai/compat';
import type {
  AssistantMessage,
  Context,
  Message,
  Model,
  ThinkingLevel,
  Tool,
  ToolResultMessage,
} from '@earendil-works/pi-ai';
import { publishDelta, publishThinking, publishToolCall, publishTurnEnd } from './publish.js';
import {
  appendMessage,
  touchSession,
  renameSession,
  loadMemoryContext,
  getExperiment,
  listExperimentRuns,
  appendExperimentRun as dbAppendExperimentRun,
  setExperimentBest,
  setExperimentStatus,
  type ExperimentStatus,
} from './db.js';
import { createTedTools, runJs, ircSayLines } from './pi-tools.js';
import { parseMetricValues } from './experiments.js';
import type { Role } from './types.js';

// The agent runs on OpenRouter via pi-ai. The workflow drives the agent
// loop: each LLM call (llmTurn) and each tool execution (executeTool) is
// its own Temporal activity.
const MODEL_ID = process.env.OPENROUTER_MODEL ?? process.env.ANTHROPIC_MODEL ?? 'z-ai/glm-5.2';
const THINKING_LEVEL = (process.env.PI_THINKING_LEVEL ?? 'medium') as ThinkingLevel | 'off';
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS ?? 64_000);
const TOOL_RESULT_MAX_CHARS = Number(process.env.TOOL_RESULT_MAX_CHARS ?? 30_000);

function openRouterKey(): string {
  return process.env.OR_API_KEY ?? process.env.OPENROUTER_API_KEY ?? '';
}

function tedModel(): Model<'openai-completions'> {
  return {
    id: MODEL_ID,
    name: MODEL_ID,
    api: 'openai-completions',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: MAX_OUTPUT_TOKENS,
  };
}

export type LlmTurnReq = {
  sessionId: string;
  userId: string;
  convo: Message[];
};

/**
 * One model call: stream a single assistant message (text, thinking, and
 * tool-call requests) and publish deltas to Redis as they arrive. Tool
 * calls are NOT executed here — the workflow schedules executeTool
 * activities for them and calls llmTurn again with the results.
 */
export async function llmTurn(req: LlmTurnReq): Promise<AssistantMessage> {
  const memoryCtx = await loadMemoryContext(req.userId);

  const systemParts: string[] = [
    'You are ted, a chat agent bridged into IRC. Keep replies short and IRC-friendly: ' +
    'plain text, no markdown headers or code fences.',
    'You can execute JavaScript in a sandboxed V8 runtime via the run_js tool — this is your ' +
    'only way to compute things. The sandbox has network access via fetch() and can import ' +
    'external ES modules (npm:/jsr:/https specifiers via esm.sh) and node: builtins. ' +
    'You can persist notes with the memory_* tools, and send raw ' +
    'IRC commands via irc_raw (e.g. "JOIN #channel", "PRIVMSG #channel :text"). After a JOIN ' +
    'the bridge starts a per-channel session and future messages from that channel arrive as new turns.',
    'Always finish with a message to the user summarizing what you did or found — never end ' +
    'a turn inside reasoning.',
  ];
  if (memoryCtx) systemParts.push(memoryCtx);

  const tools: Tool[] = createTedTools(req.userId).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  const context: Context = {
    systemPrompt: systemParts.join('\n\n'),
    messages: req.convo,
    tools,
  };

  const stream = streamSimple(tedModel(), context, {
    apiKey: openRouterKey(),
    ...(THINKING_LEVEL !== 'off' ? { reasoning: THINKING_LEVEL } : {}),
    maxTokens: MAX_OUTPUT_TOKENS,
  });

  let final: AssistantMessage | undefined;
  for await (const ev of stream) {
    heartbeat();
    if (ev.type === 'text_delta' && ev.delta) {
      void publishDelta(req.sessionId, ev.delta).catch(() => {});
    } else if (ev.type === 'thinking_delta' && ev.delta) {
      void publishThinking(req.sessionId, ev.delta).catch(() => {});
    } else if (ev.type === 'toolcall_end') {
      void publishToolCall(req.sessionId, ev.toolCall.name).catch(() => {});
    } else if (ev.type === 'done') {
      final = ev.message;
    } else if (ev.type === 'error') {
      final = ev.error;
    }
  }

  if (!final) throw new Error('LLM stream ended without a final message');
  if (final.stopReason === 'error' || final.stopReason === 'aborted') {
    throw new Error(`LLM turn failed: ${final.errorMessage ?? final.stopReason}`);
  }
  return final;
}

export type ExecuteToolReq = {
  sessionId: string;
  userId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
};

/**
 * Execute a single tool call as its own Temporal activity so every tool
 * invocation is durable, retryable, and visible in the workflow history.
 */
export async function executeTool(req: ExecuteToolReq): Promise<ToolResultMessage> {
  const tool = createTedTools(req.userId).find((t) => t.name === req.toolName);

  let text: string;
  let isError = false;
  if (!tool) {
    text = `Unknown tool: ${req.toolName}`;
    isError = true;
  } else {
    try {
      const result = await tool.execute(req.args ?? {});
      text = result.text;
      isError = result.isError ?? false;
    } catch (err) {
      text = `Tool ${req.toolName} failed: ${(err as Error).message}`;
      isError = true;
    }
  }

  if (text.length > TOOL_RESULT_MAX_CHARS) {
    text = `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n… (truncated ${text.length - TOOL_RESULT_MAX_CHARS} chars)`;
  }

  return {
    role: 'toolResult',
    toolCallId: req.toolCallId,
    toolName: req.toolName,
    content: [{ type: 'text', text }],
    isError,
    timestamp: Date.now(),
  };
}

/** Signal end-of-turn to stream consumers (the IRC bridge flushes on this). */
export async function endTurn(req: { sessionId: string }): Promise<void> {
  await publishTurnEnd(req.sessionId);
}

export type PersistTurnReq = {
  sessionId: string;
  role: Role;
  content: string;
  userId: string;
};

export async function persistTurn(req: PersistTurnReq): Promise<void> {
  await appendMessage(req.sessionId, req.role, req.content, req.userId);
  await touchSession(req.sessionId);
}

/* ------------------------------------------------------------------ */
/*  Autoresearch activities                                           */
/* ------------------------------------------------------------------ */

export type ProposeCandidateReq = {
  name: string;
  userId: string;
  guidance: string[];
};

export type CandidateProposal = {
  stop: boolean;
  reason?: string;
  description: string;
  code: string;
  bestValue: number | null;
};

/**
 * One LLM call proposing the next experiment candidate as JSON:
 * {"description": "...", "code": "..."} or {"stop": true, "reason": "..."}.
 */
export async function proposeCandidate(req: ProposeCandidateReq): Promise<CandidateProposal> {
  const exp = await getExperiment(req.name);
  if (!exp) throw new Error(`experiment not found: ${req.name}`);
  const runs = await listExperimentRuns(req.name, 10);

  const logLines = runs
    .slice()
    .reverse()
    .map((r) => `#${r.iteration} ${r.verdict} value=${r.value ?? 'n/a'} — ${r.description}`);

  const prompt = [
    `You are running an autonomous optimization loop ("autoresearch").`,
    `Goal: ${exp.goal}`,
    `Metric: ${exp.metric_name} (${exp.metric_unit || 'unitless'}), direction: ${exp.direction === 'min' ? 'lower is better' : 'higher is better'}.`,
    ``,
    `The candidate is JavaScript run in a sandboxed V8 runtime (network fetch available, npm:/jsr:/https module imports via esm.sh, node: builtins). ` +
    `Your candidate code runs first, then this measurement snippet runs in the same execution and must be able to use what the candidate defines:`,
    '--- measure snippet ---',
    exp.measure_code,
    '--- end measure snippet ---',
    `The measurement prints lines like "METRIC ${exp.metric_name}=<number>".`,
    ``,
    exp.best_code
      ? `Current best (value ${exp.best_value}):\n--- best candidate ---\n${exp.best_code}\n--- end best candidate ---`
      : `No baseline yet — your first candidate establishes it.`,
    logLines.length > 0 ? `Recent runs:\n${logLines.join('\n')}` : '',
    req.guidance.length > 0 ? `Operator guidance (follow it):\n${req.guidance.join('\n')}` : '',
    ``,
    `Propose ONE next candidate: a focused, single-idea change (or the initial implementation). ` +
    `Reply with ONLY a JSON object, no code fences, in one of these shapes:`,
    `{"description": "<one line: the idea being tested>", "code": "<complete candidate JavaScript>"}`,
    `{"stop": true, "reason": "<why further iteration is not worthwhile>"}`,
  ]
    .filter(Boolean)
    .join('\n');

  const msg = await completeSimple(tedModel(), {
    systemPrompt: 'You are an optimization researcher. Reply with only the requested JSON.',
    messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
  }, {
    apiKey: openRouterKey(),
    ...(THINKING_LEVEL !== 'off' ? { reasoning: THINKING_LEVEL } : {}),
    maxTokens: MAX_OUTPUT_TOKENS,
  });

  const text = (Array.isArray(msg.content) ? msg.content : [])
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b.text ?? '')
    .join('')
    .trim();

  const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    const m = jsonText.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`proposal was not JSON: ${text.slice(0, 200)}`);
    parsed = JSON.parse(m[0]);
  }

  if (parsed.stop) {
    return { stop: true, reason: String(parsed.reason ?? ''), description: '', code: '', bestValue: exp.best_value };
  }
  if (typeof parsed.code !== 'string' || !parsed.code.trim()) {
    throw new Error('proposal missing code');
  }
  return {
    stop: false,
    description: String(parsed.description ?? 'unnamed candidate'),
    code: parsed.code,
    bestValue: exp.best_value,
  };
}

export type MeasureCandidateReq = {
  name: string;
  code: string;
  samples: number;
};

/**
 * Run candidate + measure snippet in the mcp-js sandbox N times (stateless
 * executions so a discarded candidate leaves no residue) and collect
 * METRIC values.
 */
export async function measureCandidate(req: MeasureCandidateReq): Promise<{ values: number[]; lastOutput: string }> {
  const exp = await getExperiment(req.name);
  if (!exp) throw new Error(`experiment not found: ${req.name}`);
  const program = `${req.code}\n;\n${exp.measure_code}`;
  const values: number[] = [];
  let lastOutput = '';
  for (let i = 0; i < req.samples; i++) {
    heartbeat();
    try {
      lastOutput = await runJs(program);
    } catch (err) {
      lastOutput = `execution error: ${(err as Error).message}`;
      continue;
    }
    const found = parseMetricValues(lastOutput, exp.metric_name);
    if (found.length > 0) values.push(found[found.length - 1]);
  }
  return { values, lastOutput: lastOutput.slice(-2000) };
}

export type RecordExperimentRunReq = {
  name: string;
  iteration: number;
  description: string;
  code: string;
  samples: number[];
  value: number | null;
  verdict: string;
};

export async function recordExperimentRun(req: RecordExperimentRunReq): Promise<void> {
  await dbAppendExperimentRun(req);
  if ((req.verdict === 'keep' || req.verdict === 'baseline') && req.value !== null) {
    await setExperimentBest(req.name, req.value, req.code);
  }
}

export async function finishExperiment(req: { name: string; status: ExperimentStatus }): Promise<void> {
  await setExperimentStatus(req.name, req.status);
}

/** Post a line of text to an IRC channel via the bridge. */
export async function ircSay(req: { channel: string; text: string }): Promise<void> {
  await ircSayLines(req.channel, req.text);
}

const TITLE_MODEL =
  process.env.OPENROUTER_TITLE_MODEL ?? process.env.ANTHROPIC_TITLE_MODEL ?? MODEL_ID;

export type GenerateTitleReq = {
  sessionId: string;
  userMessage: string;
  userId: string;
};

export async function generateTitle(req: GenerateTitleReq): Promise<void> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${openRouterKey()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: TITLE_MODEL,
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content:
              'Summarise the following message as a concise 3-6 word chat ' +
              'title. Reply with ONLY the title text, no quotes, no ' +
              "punctuation, no leading 'Title:'.\n\n" +
              req.userMessage,
          },
        ],
      }),
    });
    if (!res.ok) return;
    const json: any = await res.json();
    let title = String(json?.choices?.[0]?.message?.content ?? '');
    title = title
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/\.+$/, '')
      .slice(0, 80)
      .trim();
    if (!title) return;
    await renameSession(req.sessionId, req.userId, title);
  } catch {
    // Best-effort
  }
}
