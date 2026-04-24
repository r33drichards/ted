# Ted

Durable Claude chat agent powered by the Claude Agent SDK, Temporal workflows, and an IRC bridge.

## Architecture

- `src/activities.ts` — Temporal activities: `streamClaude` (Agent SDK query), `persistTurn`, `generateTitle`
- `src/memory-mcp.ts` — In-process MCP server for memory CRUD (working/short_term/long_term)
- `src/workflows.ts` — Temporal chatSession workflow
- `src/webhook.ts` — Hono HTTP API (message ingestion, sessions, SSE streaming)
- `src/irc-bridge.ts` — IRC bridge (InspIRCd on Railway private network)
- `src/db.ts` — Postgres schema + CRUD (messages, sessions, mcp_servers, memories)
- `src/publish.ts` — Redis Streams for SSE deltas (delta, thinking, tool_call, turn_end)
- `.claude/skills/` — Agent skills (auto-discovered, self-editable)

## Agent Capabilities

The agent uses the Claude Agent SDK with these tools enabled:
- Read, Write, Edit, Glob, Grep (filesystem)
- WebSearch, WebFetch (web)
- Skill (self-editable skills in .claude/skills/)
- Agent (subagents)
- MCP tools (from configured servers)
- Memory tools (via in-process MCP server)

No Bash or Monitor access.

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
