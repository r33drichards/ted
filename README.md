# claude-temporal-chat

Durable Claude chat sessions over Temporal. One workflow per session, webhook for message delivery.

## Prereqs

- Node 20+
- `temporal` CLI (`brew install temporal`)
- `ANTHROPIC_API_KEY` set

## Run locally

Three terminals:

```bash
# Terminal 1 — Temporal dev server
temporal server start-dev

# Terminal 2 — worker
export ANTHROPIC_API_KEY=sk-ant-...
npm run worker

# Terminal 3 — webhook
npm run webhook
```

## Smoke test

```bash
# Send a message — creates the session workflow
curl -X POST http://localhost:8787/message \
  -H 'content-type: application/json' \
  -d '{"sessionId":"test-1","msg":"hello, who are you?"}'

# Send a follow-up to the same session
curl -X POST http://localhost:8787/message \
  -H 'content-type: application/json' \
  -d '{"sessionId":"test-1","msg":"what did i just ask?"}'
```

Open the Temporal UI at http://localhost:8233 to inspect the workflow — there should be exactly one with ID `chat:test-1`, and its history should show two `userMessage` signals and two activity completions.

## Tests

```bash
npm test         # unit + workflow tests
npm run typecheck
```

Workflow tests need a Temporal CLI binary. If the test SDK's download is blocked in your environment, point it at a locally-installed binary:

```bash
TEMPORAL_CLI_PATH=$(which temporal) npm test
```

## Architecture

- `src/workflows.ts` — `chatSession` workflow. Holds inbox + history, signal handlers, calls streaming activity.
- `src/inbox.ts` — pure `drainInbox` helper (inbox → history as one user turn).
- `src/activities.ts` — `streamClaude` activity. Streams via Anthropic SDK, publishes deltas, heartbeats.
- `src/publish.ts` — stub for fan-out of streaming deltas. Replace with Redis pub/sub, SSE relay, etc.
- `src/signals.ts` — signal and query definitions.
- `src/worker.ts` — Temporal worker bootstrap.
- `src/webhook.ts` — Hono webhook. `POST /message { sessionId, msg }` → `signalWithStart`.

## Key semantics

- **Partition by `sessionId`.** Workflow ID is `chat:${sessionId}`, which Temporal enforces as unique per running workflow.
- **Get-or-create.** `signalWithStart` atomically starts the workflow if absent and delivers the signal; no race.
- **No cancel on message.** Messages that arrive during a Claude generation queue in the inbox and become the *next* user turn. The in-flight call completes.
- **Coalescing.** Multiple messages queued during one generation are joined into a single user turn (Claude requires alternating roles).
- **Unbounded session length.** `continueAsNew` kicks in at 2000 workflow-history events with the current `history` passed forward.
