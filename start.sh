#!/bin/sh
# Route to the right process based on SERVICE_TYPE env var
# SERVICE_TYPE=irc  -> IRC bridge only
# default           -> webhook + worker

case "${SERVICE_TYPE}" in
  irc)
    exec node --loader ts-node/esm src/irc-bridge.ts
    ;;
  *)
    node --loader ts-node/esm src/webhook.ts &
    PID_WEBHOOK=$!

    node --loader ts-node/esm src/worker.ts &
    PID_WORKER=$!

    trap 'kill $PID_WEBHOOK $PID_WORKER 2>/dev/null; exit' INT TERM

    while kill -0 $PID_WEBHOOK 2>/dev/null && kill -0 $PID_WORKER 2>/dev/null; do
      sleep 1
    done

    echo "A process exited, shutting down..."
    kill $PID_WEBHOOK $PID_WORKER 2>/dev/null
    exit 1
    ;;
esac

