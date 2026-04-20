# claude-agent-image

Nix-built Docker image bundling `claude-code` (from nixpkgs), Node.js 22, Chromium, git, curl, and a stdin-to-`claude -p` entrypoint. Designed for AWS Bedrock auth.

## Build

```bash
nix build .#image
# result -> claude-agent.tar.gz (OCI/docker archive)
```

## Load

```bash
docker load -i result     # or: podman load -i result
# -> claude-agent:latest
```

## Run (AWS Bedrock)

```bash
echo 'What is 2+2?' | docker run --rm -i \
  -e AWS_ACCESS_KEY_ID=... \
  -e AWS_SECRET_ACCESS_KEY=... \
  -e AWS_REGION=us-east-1 \
  -e ANTHROPIC_MODEL=us.anthropic.claude-haiku-4-5-20251001-v1:0 \
  -e ANTHROPIC_SMALL_FAST_MODEL=us.anthropic.claude-haiku-4-5-20251001-v1:0 \
  claude-agent:latest
```

`CLAUDE_CODE_USE_BEDROCK=1` is set by default in the image env.

### Entrypoint

- **Non-TTY stdin** → content is read and passed to `claude -p <input>`. Extra args forwarded.
- **TTY** → launches `claude` interactively with forwarded args.

## What's inside

- `claude-code` (nixpkgs)
- `nodejs_22`
- `chromium` (for browser tooling)
- `git`, `curl`, `coreutils`, `bash`
- `cacert` (NODE_EXTRA_CA_CERTS, SSL_CERT_FILE preset)

## Layers

Uses `dockerTools.buildLayeredImage` so each Nix store path becomes its own layer — good dedup across rebuilds.
