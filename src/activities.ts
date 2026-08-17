import { heartbeat } from '@temporalio/activity';
import { existsSync, mkdirSync } from 'fs';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import { publishDelta, publishThinking, publishToolCall, publishTurnEnd } from './publish.js';
import {
  appendMessage,
  touchSession,
  renameSession,
  loadMemoryContext,
} from './db.js';
import { createTedTools } from './pi-tools.js';
import type { Role, StreamReq } from './types.js';

// The agent runs on OpenRouter via the pi agent harness (no Claude Code
// binary, no Anthropic-compat shim).
const MODEL_ID = process.env.OPENROUTER_MODEL ?? process.env.ANTHROPIC_MODEL ?? 'z-ai/glm-5.2';
const THINKING_LEVEL = (process.env.PI_THINKING_LEVEL ?? 'medium') as any;

function openRouterKey(): string {
  return process.env.OR_API_KEY ?? process.env.OPENROUTER_API_KEY ?? '';
}

const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH ?? '/tmp';
const PI_DIR = process.env.PI_AGENT_DIR ?? `${VOLUME}/pi-agent`;
const SESSION_DIR = `${PI_DIR}/sessions`;

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
    maxTokens: 64_000,
  };
}

/**
 * Stream an assistant turn using the pi agent harness against OpenRouter.
 *
 * Multi-turn context comes from pi's persistent session files (on the
 * Railway volume); `sdkSessionId` carries the session file path across
 * turns and continue-as-new.
 *
 * Returns { text, sdkSessionId } so the workflow can track the session.
 */
export async function streamClaude(req: StreamReq): Promise<{ text: string; sdkSessionId: string }> {
  const memoryCtx = await loadMemoryContext(req.userId);
  mkdirSync(SESSION_DIR, { recursive: true });

  const modelRuntime = await ModelRuntime.create({ authPath: `${PI_DIR}/auth.json` });
  await modelRuntime.setRuntimeApiKey('openrouter', openRouterKey());

  const systemParts: string[] = [
    'You are ted, a chat agent bridged into IRC. Keep replies short and IRC-friendly: ' +
    'plain text, no markdown headers or code fences.',
    'You can execute JavaScript in a sandboxed V8 runtime via the run_js tool — this is your ' +
    'only way to compute things. You can persist notes with the memory_* tools, and send raw ' +
    'IRC commands via irc_raw (e.g. "JOIN #channel", "PRIVMSG #channel :text"). After a JOIN ' +
    'the bridge starts a per-channel session and future messages from that channel arrive as new turns.',
    'Always finish your turn with a message to the user summarizing what you did or found — ' +
    'never end a turn inside reasoning.',
  ];
  if (memoryCtx) systemParts.push(memoryCtx);

  const loader = new DefaultResourceLoader({
    cwd: '/app',
    agentDir: PI_DIR,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: systemParts.join('\n\n'),
  });
  await loader.reload();

  // Resume the previous pi session file when it still exists.
  let sessionManager: SessionManager;
  const prior = req.sdkSessionId ?? '';
  if (prior && existsSync(prior)) {
    try {
      sessionManager = SessionManager.open(prior, SESSION_DIR);
    } catch (err) {
      console.log(`[agent] failed to open session ${prior} (${(err as Error).message}), starting fresh`);
      sessionManager = SessionManager.create('/app', SESSION_DIR);
    }
  } else {
    if (prior) console.log(`[agent] stale session ${prior}, starting fresh`);
    sessionManager = SessionManager.create('/app', SESSION_DIR);
  }

  const { session } = await createAgentSession({
    cwd: '/app',
    agentDir: PI_DIR,
    modelRuntime,
    model: tedModel(),
    thinkingLevel: THINKING_LEVEL,
    noTools: 'builtin',
    customTools: createTedTools(req.userId),
    resourceLoader: loader,
    sessionManager,
  });

  const lastUserMsg = req.history.filter((m) => m.role === 'user').pop();
  const prompt = lastUserMsg?.content ?? '';

  let lastAssistantText = '';
  const unsubscribe = session.subscribe((event) => {
    heartbeat();
    if (event.type === 'message_update') {
      const ev = event.assistantMessageEvent;
      if (ev.type === 'text_delta' && ev.delta) {
        void publishDelta(req.sessionId, ev.delta).catch(() => {});
      } else if (ev.type === 'thinking_delta' && ev.delta) {
        void publishThinking(req.sessionId, ev.delta).catch(() => {});
      }
    } else if (event.type === 'tool_execution_start') {
      void publishToolCall(req.sessionId, event.toolName).catch(() => {});
    } else if (event.type === 'turn_end') {
      const msg = event.message as any;
      if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
        const text = msg.content
          .filter((b: any) => b?.type === 'text')
          .map((b: any) => b.text ?? '')
          .join('');
        if (text.trim()) lastAssistantText = text;
      }
    }
  });

  let sdkSessionId = '';
  try {
    await session.prompt(prompt);
    sdkSessionId = session.sessionFile ?? '';
  } finally {
    unsubscribe();
    session.dispose();
    await publishTurnEnd(req.sessionId);
  }

  return { text: lastAssistantText, sdkSessionId };
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
