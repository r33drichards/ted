# Ted

Durable Claude chat app with Temporal workflows, MCP tool integration, and an IRC bridge.

## E2E Testing

After deploying changes, run the IRC e2e test to verify the full pipeline:

```
node e2e/irc-e2e.mjs
```

Options:
- `--message "your message"` — custom test message (default: "what is 2+2?")
- `--timeout 90` — seconds to wait for response (default: 60)

The test connects to IRC via `railway ssh`, sends a message in #ted, waits for ted-bot's response, and checks: response received, no markdown, reasonable length.

## Deploy

Push to master. Railway auto-deploys both services (`ted` and `ted-irc-bridge`).

After deploy, if the IRC workflow has changed shape (new/removed activities), terminate the old workflow:

```
railway ssh -s ted -- 'node -e "
const { Connection, Client } = require(\"@temporalio/client\");
(async () => {
  const conn = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS });
  const client = new Client({ connection: conn });
  const h = client.workflow.getHandle(\"chat:irc-ted\");
  await h.terminate(\"deploy reset\");
  console.log(\"terminated\");
  process.exit(0);
})();
"'
```

Then send a message in IRC or restart the bridge to create a fresh workflow.

## Architecture

- `src/activities.ts` — Claude streaming, built-in tools (MCP management, memories), tool loop
- `src/workflows.ts` — Temporal chatSession workflow
- `src/webhook.ts` — Hono HTTP API
- `src/irc-bridge.ts` — IRC bridge (connects to InspIRCd on Railway private network)
- `src/mcp-client.ts` — MCP HTTP client
- `src/db.ts` — Postgres schema + CRUD
- `src/publish.ts` — Redis Streams for SSE deltas (delta, thinking, tool_call, turn_end)
