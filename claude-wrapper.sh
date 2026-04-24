#!/bin/sh
# Run Claude Code as non-root (bypassPermissions requires non-root)
exec runuser -u ted -- /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude "$@"
