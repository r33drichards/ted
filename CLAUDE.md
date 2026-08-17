# Ted

Durable chat agent powered by the pi agent harness (@earendil-works/pi-coding-agent) running GLM on OpenRouter, Temporal workflows, and an IRC bridge.

## Architecture

- `src/activities.ts` — Temporal activities: `streamClaude` (pi agent session against OpenRouter), `persistTurn`, `generateTitle`
- `src/pi-tools.ts` — Custom pi tools: `run_js` (mcp-js REST sidecar), memory CRUD (working/short_term/long_term), `irc_raw`
- `src/workflows.ts` — Temporal chatSession workflow
- `src/webhook.ts` — Hono HTTP API (message ingestion, sessions, SSE streaming)
- `src/irc-bridge.ts` — IRC bridge (InspIRCd on Railway private network)
- `src/db.ts` — Postgres schema + CRUD (messages, sessions, mcp_servers, memories)
- `src/publish.ts` — Redis Streams for SSE deltas (delta, thinking, tool_call, turn_end)
- `.claude/skills/` — Agent skills (auto-discovered, self-editable)

## Agent Capabilities

The agent runs on pi (`createAgentSession`) with built-in coding tools disabled and only these custom tools:
- `run_js` — sandboxed V8 execution via the mcp-js REST sidecar (`POST /api/exec` on mcp-js-p1ze.railway.internal:8080)
- `memory_set/get/delete/list/search` — Postgres-backed memory tiers
- `irc_raw` — raw IRC commands via the bridge's HTTP endpoint

Model comes from `OPENROUTER_MODEL` (fallback `ANTHROPIC_MODEL`, default `z-ai/glm-5.2`), key from `OR_API_KEY`, thinking level from `PI_THINKING_LEVEL` (default `medium`). Pi session files live on the Railway volume (`RAILWAY_VOLUME_MOUNT_PATH/pi-agent/sessions`); the workflow's `sdkSessionId` is the session file path.

## E2E Testing

```
node e2e/irc-e2e.mjs [--message "text"] [--timeout 90]
```

## Deploy

Push to master. Railway auto-deploys `ted` and `ted-irc-bridge`.

After workflow-shape changes, terminate the old workflow:
```
railway ssh -s ted -- 'node -e "
const { Connection, Client } = require(\"@temporalio/client\");
(async () => {
  const conn = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS });
  const client = new Client({ connection: conn });
  await client.workflow.getHandle(\"chat:irc-ted\").terminate(\"deploy reset\");
  process.exit(0);
})();
"'
```
