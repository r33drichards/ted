# Skill: Modal (from the run_js sandbox)

Modal is a serverless cloud platform for AI/compute workloads (scalable containers, GPUs, sandboxes). Use this whenever the user mentions Modal, wants to run scalable Python/batch jobs, needs GPUs, or needs to run untrusted code in a sandbox.

Adapted for ted's environment (mcp-js JS sandbox) from Modal's official skill:
https://github.com/modal-labs/modal-client/blob/main/py/modal/skills/modal/SKILL.md

## Your environment: JavaScript only, no CLI, no Python

ted runs in the mcp-js V8 sandbox. You **cannot** use the `modal` CLI or the Python SDK, and there is no `modal token` step — credentials are already injected server-side (see below). You interact with Modal via the **JavaScript SDK** through `run_js`. The JS SDK's scope is: (1) create and interact with **Sandboxes**, and (2) look up and call **deployed Modal Functions** (Functions themselves are defined in Python elsewhere). It is less mature than the Python SDK; when unsure, consult the JS SDK examples: https://github.com/modal-labs/modal-client/blob/main/js/README.md

## Setup boilerplate (top of every Modal run_js call)

```js
import { ModalClient } from 'npm:modal?target=node';
import { Buffer } from 'node:buffer';
import process from 'node:process';
globalThis.Buffer = Buffer;      // Node-target SDK expects these globals
globalThis.process = process;

// Credentials (x-modal-token-id / x-modal-token-secret) are INJECTED
// server-side for api.modal.com — do NOT put real tokens here. Pass the
// public token id + a placeholder secret; the real secret is substituted
// at the gRPC metadata layer and cannot be read from JS.
const modal = new ModalClient({
  tokenId: 'ak-LBdsLfmsxJ2uVmYUwfaNya',
  tokenSecret: 'as-injected-server-side',
});
```

Notes: `?target=node` selects the Node build. Only `api.modal.com` is reachable (host-scoped http2 policy). Modal requires network + auth — there is no offline/local mode.

## Common operations

Call a deployed Function:
```js
const fn = await modal.functions.fromName('my-app', 'my-fn');
console.log(JSON.stringify(await fn.remote(['arg'], { kw: 'v' })));
// async spawn: const fc = await fn.spawn(['arg']); const r = await fc.get();
```

Create and drive a Sandbox:
```js
const app = await modal.apps.fromName('sandbox-app', { createIfMissing: true });
const image = modal.images.fromRegistry('alpine:3.21');
const sb = await modal.sandboxes.create(app, image, { command: ['cat'] });
await sb.stdin.writeText('hi'); await sb.stdin.close();
console.log(await sb.stdout.readText());
await sb.terminate();
```
Sandbox create params: `secrets`, `timeoutMs`, `cpu`, `memoryMiB`, `outboundDomainAllowlist`, ….

Service methods on `ModalClient`: `apps`, `functions`, `sandboxes`, `images`, `secrets`, `volumes`. Errors are typed classes — match with `instanceof`.

## Docs

Official docs index (plain-text with `.md`): https://modal.com/llms.txt — fetch specific Guide / API Reference / Examples pages from there when planning or debugging. Do not read the full https://modal.com/llms-full.txt into context. Your training knowledge may be stale; the docs are authoritative for recent features.
