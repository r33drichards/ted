#!/bin/sh
# Route to the right process based on SERVICE_TYPE env var
# SERVICE_TYPE=irc  -> IRC bridge only
# default           -> webhook + worker

# Create non-root user for Claude Code SDK (bypassPermissions blocked as root)
id ted >/dev/null 2>&1 || useradd -m ted 2>/dev/null || true
# Ensure skills volume is writable by ted user
chown -R ted:ted /app/.claude 2>/dev/null || true

case "${SERVICE_TYPE}" in
  irc)
    exec node --loader ts-node/esm src/irc-bridge.ts
    ;;
  *)
    node --loader ts-node/esm src/webhook.ts &
    PID_WEBHOOK=$!

    node --loader ts-node/esm src/worker.ts &
    PID_WORKER=$!

    # wpfs MCP server (WordPress volume access for the mcp-js sandbox).
    # Best-effort: not part of the liveness check.
    node --loader ts-node/esm src/wpfs-mcp.ts &

    trap 'kill $PID_WEBHOOK $PID_WORKER 2>/dev/null; exit' INT TERM

    while kill -0 $PID_WEBHOOK 2>/dev/null && kill -0 $PID_WORKER 2>/dev/null; do
      sleep 1
    done

    echo "A process exited, shutting down..."
    kill $PID_WEBHOOK $PID_WORKER 2>/dev/null
    exit 1
    ;;
esac

