#!/usr/bin/env bash
# Smoke test: build image, run it with Bedrock auth, verify response.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Building image with Nix"
nix --extra-experimental-features 'nix-command flakes' build .#image

echo "==> Loading image into podman"
podman load -i result

PROMPT='What is 2+2? Reply with ONLY the number, no explanation.'
MODEL="${ANTHROPIC_MODEL:-us.anthropic.claude-haiku-4-5-20251001-v1:0}"
REGION="${AWS_REGION:-us-east-1}"

echo "==> Running image (model=$MODEL, region=$REGION)"
out=$(
  echo "$PROMPT" | podman run --rm -i \
    -e AWS_ACCESS_KEY_ID="$(aws configure get aws_access_key_id)" \
    -e AWS_SECRET_ACCESS_KEY="$(aws configure get aws_secret_access_key)" \
    -e AWS_REGION="$REGION" \
    -e ANTHROPIC_MODEL="$MODEL" \
    -e ANTHROPIC_SMALL_FAST_MODEL="$MODEL" \
    localhost/claude-agent:latest
)

echo "--- OUTPUT ---"
echo "$out"
echo "--------------"

if [[ "$out" == *"4"* ]]; then
  echo "PASS"
else
  echo "FAIL: expected '4' in output" >&2
  exit 1
fi
