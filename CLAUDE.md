# Ted

Durable chat agent powered by the pi agent harness (@earendil-works/pi-coding-agent) running GLM on OpenRouter, Temporal workflows, and an IRC bridge.

## Architecture

- `src/activities.ts` — Temporal activities: `llmTurn` (one pi-ai model call against OpenRouter, streams deltas to Redis), `executeTool` (one tool call), `endTurn`, `persistTurn`, `generateTitle`
- `src/workflows.ts` — chatSession workflow owns the agent loop: llmTurn → executeTool per tool call (parallel) → repeat; the LLM conversation (`convo`) is workflow state, trimmed and carried through continue-as-new
- `src/pi-tools.ts` — Tool defs (schema + execute): `run_js` (mcp-js REST sidecar), memory CRUD (working/short_term/long_term), `irc_raw`, `experiment_start/stop/status`, `schedule_create/list/delete/trigger` (Temporal Schedules → `scheduledPrompt` workflow → webhook `/message`, prompt arrives as "scheduler: …" in the target channel's session), `channels_add/remove/list` (Postgres autojoin list; the bridge fetches `GET /autojoin` on connect and joins them)
- `src/experiments.ts` + `autoresearch` workflow — pi-autoresearch pattern: per-experiment workflow (`auto:<name>`) proposes candidate JS (LLM activity), measures it in the sandbox, keeps improvements (median/MAD verdicts); progress + steering via IRC channel `#auto-<name>` (webhook routes that channel's messages to the experiment's steer signal, docs/plans/2026-08-17-autoresearch-irc-design.md)
- `src/workflows.ts` — Temporal chatSession workflow
- `src/webhook.ts` — Hono HTTP API (message ingestion, sessions, SSE streaming)
- `src/irc-bridge.ts` — IRC bridge (InspIRCd on Railway private network). Admin commands with `,` prefix handled by the bridge itself, never the agent: `,stop`/`,cancel` (force-stop the channel's in-flight turn or experiment via `POST /sessions/:id/stop` → cancelTurn/steer signal), `,join #a,#b`, `,part #a`, `,send <raw or /cmd>`, `,help`
- `src/db.ts` — Postgres schema + CRUD (messages, sessions, mcp_servers, memories)
- `src/publish.ts` — Redis Streams for SSE deltas (delta, thinking, tool_call, turn_end)
- `.claude/skills/` — Agent skills (auto-discovered, self-editable)

## Agent Capabilities

Every LLM call and every tool call is a Temporal activity — durable, retryable, and visible in workflow history. Tools:
- `run_js` — sandboxed V8 execution via the mcp-js REST sidecar (`POST /api/exec` on mcp-js-p1ze.railway.internal:8080)
- `memory_set/get/delete/list/search` — Postgres-backed memory tiers
- `irc_raw` — raw IRC commands via the bridge's HTTP endpoint

Model comes from `OPENROUTER_MODEL` (fallback `ANTHROPIC_MODEL`, default `z-ai/glm-5.2`), key from `OR_API_KEY`, thinking level from `PI_THINKING_LEVEL` (default `medium`, `off` to disable).

## E2E Testing

```
node e2e/irc-e2e.mjs [--message "text"] [--timeout 90]
```

## Deploy

Push to master. Railway auto-deploys `ted` and `ted-irc-bridge`.

Workflow IDs are `chat2:<sessionId>`. After a workflow-shape change, bump `WF_PREFIX` in `src/webhook.ts` — the webhook lazily terminates the previous-prefix workflow for a session when its next message arrives, so no manual `railway ssh` terminate is needed.
