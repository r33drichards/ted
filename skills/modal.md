# Skill: calling Modal from the run_js sandbox

The run_js V8 sandbox can drive [Modal](https://modal.com) (serverless containers, GPUs, sandboxes, functions, volumes) via the official `modal` npm SDK. Modal's API is gRPC-over-HTTP/2 to `api.modal.com`; the sandbox reaches it through the built-in `node:http2` transport, and credentials are injected server-side so they never appear in your code.

## Setup boilerplate (required at the top of any Modal run_js call)

```js
import { ModalClient } from 'npm:modal?target=node';
import { Buffer } from 'node:buffer';
import process from 'node:process';
// The Node-target SDK expects these as globals:
globalThis.Buffer = Buffer;
globalThis.process = process;

// Credentials (x-modal-token-id / x-modal-token-secret) are INJECTED
// server-side for api.modal.com — do not put real tokens here. Pass the
// public token id and any placeholder secret; the real secret is
// substituted at the gRPC metadata layer and can't be read from JS.
const modal = new ModalClient({
  tokenId: 'ak-LBdsLfmsxJ2uVmYUwfaNya',
  tokenSecret: 'as-injected-server-side',
});
```

Notes:
- `?target=node` selects the Node build (imports `node:*` builtins this runtime serves), not the browser build. External module imports are enabled.
- Only `api.modal.com` is reachable (http2 policy is host-scoped); other hosts are blocked.
- Raw TCP is unavailable by design; the SDK's Function-*definition* features (Python-only runtime) don't apply — you interact with already-deployed Modal objects: Apps, Functions, Sandboxes, Images, Secrets, Volumes.

## Common operations

Look up and invoke a deployed Function:
```js
const fn = await modal.functions.fromName('my-app', 'my-fn');
const out = await fn.remote(['arg1'], { kw: 'value' });
console.log(JSON.stringify(out));
```

Create and use a Sandbox:
```js
const app = await modal.apps.fromName('sandbox-app', { createIfMissing: true });
const image = modal.images.fromRegistry('alpine:3.21');
const sb = await modal.sandboxes.create(app, image, { command: ['cat'] });
await sb.stdin.writeText('hello'); await sb.stdin.close();
console.log(await sb.stdout.readText());
await sb.terminate();
```

Sandbox creation params: `secrets`, `timeoutMs`, `cpu`, `memoryMiB`,
`outboundDomainAllowlist`, and more.

## Reference (Modal JS SDK)

Objects obtained via service methods on `ModalClient`: `apps`, `functions`,
`sandboxes`, `images`, `secrets`, `volumes`. Function invocation:
`.remote(args, kwargs)` (sync call), `.spawn(args)` → `FunctionCall`, then
`.get()`. Errors are typed classes — match with `instanceof`. The SDK is
beta (0.x); Python remains the only Function *runtime*, so JS is for
interacting with remote Modal objects, not defining Functions.

Full docs: https://www.npmjs.com/package/modal and https://modal.com/docs/sdk/js/latest
