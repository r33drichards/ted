# claude-temporal-chat

Durable Claude chat sessions over Temporal. One workflow per session, webhook for message delivery.

## Prereqs

- Node 20+
- `temporal` CLI (`brew install temporal`)
- Redis 7+ (for streaming fan-out)
- Postgres 14+ (for durable message history)
- `ANTHROPIC_API_KEY` set
- Optional: `REDIS_URL` (default `redis://localhost:6379`), `DATABASE_URL` (default `postgres://localhost:5432/chat`)

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

## HTTP API

- `POST /message` — body `{ sessionId, msg }`. Delivers the message to the session's workflow (starting it if absent).
- `GET /sessions/:sessionId/messages` — returns `{ sessionId, messages: [{role, content}, ...] }` from Postgres. Committed turns only.
- `GET /sessions/:sessionId/stream` — Server-Sent Events of live generation.
  - Each event is a JSON `{ type: "delta", text }` or `{ type: "turn_end" }`.
  - Reconnect with `Last-Event-ID` header (or `?from=<streamId>`) to resume.
  - `?from=0` replays from the start of the Redis stream (bounded by `MAXLEN ~ 5000`).
  - Default starts live (`$`).

Example:

```bash
# tail the session
curl -N http://localhost:8787/sessions/test-1/stream

# fetch committed history
curl http://localhost:8787/sessions/test-1/messages
```

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
- `src/publish.ts` — Redis Streams fan-out of streaming deltas (`publishDelta`, `publishTurnEnd`, `subscribeDeltas`).
- `src/redis.ts` — singleton ioredis client.
- `src/db.ts` — Postgres pool + `messages` table (`ensureSchema`, `appendMessage`, `getMessages`).
- `src/signals.ts` — signal and query definitions.
- `src/worker.ts` — Temporal worker bootstrap.
- `src/webhook.ts` — Hono webhook. `POST /message { sessionId, msg }` → `signalWithStart`.

## Key semantics

- **Partition by `sessionId`.** Workflow ID is `chat:${sessionId}`, which Temporal enforces as unique per running workflow.
- **Get-or-create.** `signalWithStart` atomically starts the workflow if absent and delivers the signal; no race.
- **No cancel on message.** Messages that arrive during a Claude generation queue in the inbox and become the *next* user turn. The in-flight call completes.
- **Coalescing.** Multiple messages queued during one generation are joined into a single user turn (Claude requires alternating roles).
- **Unbounded session length.** `continueAsNew` kicks in at 2000 workflow-history events with the current `history` passed forward.
