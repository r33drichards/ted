# Handoff: deploy mcp-js (Modal-connected) on Kubernetes

You are an agent working in a cloud IaC repository. Your task: bootstrap a deployment of **mcp-js** — a sandboxed V8 JavaScript runtime with an MCP (Model Context Protocol) server interface — into the Kubernetes cluster this repo manages, configured so sandboxed JS can call **Modal** (modal.com) over gRPC with credentials injected server-side. A working reference deployment exists on Railway; this document transfers everything learned building it, including the failure modes, so you don't rediscover them.

Use the repo's existing IaC conventions (Helm/Kustomize/Terraform/plain manifests — whatever this repo uses). Where this doc shows raw Kubernetes YAML fragments, translate them into the local idiom.

## What mcp-js is

- Source: https://github.com/r33drichards/mcp-js — Rust server (`mcp-v8`) embedding V8 isolates.
- Speaks MCP over Streamable HTTP on port **8080** (path `/mcp`) and exposes a REST sidecar API (`POST /api/exec`, `GET /api/executions/{id}`, `GET /api/executions/{id}/output`).
- Sandboxed JS gets: `fetch()` (policy-gated), external ES module imports (esm.sh, `npm:` specifiers), a Node-compat layer (`node:http2`, `node:crypto`, `node:stream`, `node:buffer`, `node:process`, timers, etc.), WebSocket and HTTP/2 clients (policy-gated), and optional upstream MCP servers callable in-sandbox via `mcp.callTool()`.
- Docs live in the repo under `site-docs/how-to/` (`fetch.md`, `http2.md`, `websocket.md`) and `server/src/cli.rs` is the authoritative flag reference. **The README's `--stateless` flag is stale** — the real spelling is `--heap-store none`. Trust `--help`/cli.rs over the README.
- CLI flags generally have env-var equivalents with the `MCP_V8_` prefix (e.g. `MCP_V8_HEAP_STORE`, `MCP_V8_POLICIES_JSON`). Verify exact names against `server/src/cli.rs`.

## Image

Build from source (Dockerfile in the repo) or reuse a published image if one exists. **Commit floor: `27934dc` (2026-08-18) or later.** Required functionality landed recently:

- PR #241 — HTTP/2 + gRPC transport (`node:http2`) and WebSocket, both policy-gated with server-side header injection. This is what makes the Modal SDK possible at all (Modal's API is gRPC-over-HTTP/2).
- PR #243 — `node:crypto` + other Node builtins (Modal's `uuid@11` dep needs crypto) **and** a rustls CryptoProvider fix without which every TLS connect from `node:http2` panics.
- PR #244 — cleared-timer unref fix; without it WASM/SDK packages that arm long keep-alive timers wedge isolates forever and starve the execution pool.

The build is a full Rust/V8 compile — expect ~10+ minutes cold; budget CI CPU/RAM accordingly.

## Deployment shape

One Deployment (single replica to start; sessions are stateful on local disk), one ClusterIP Service on 8080, one PVC, one ConfigMap (policies), one Secret (header-injection config). **No Ingress** — see Security below.

### Container configuration

Set via env (or args; env shown):

| Env var | Value | Why |
|---|---|---|
| `MCP_V8_HEAP_STORE` | `none` | **Critical:** heap persistence runs isolates inside a V8 SnapshotCreator, which disables WebAssembly entirely — silently, no warning. `none` keeps `WebAssembly` available. |
| `MCP_V8_FS_STORE` | `dir` (its path flag → PVC mount) | Per-session `/work` file persistence. FS store does **not** trigger the snapshot isolate, so it composes fine with WASM. Check cli.rs for the exact path flag. |
| `MCP_V8_ALLOW_EXTERNAL_MODULES` | `true` | Enables `npm:`/esm.sh imports (the Modal SDK is imported as `npm:modal?target=node`). |
| `MCP_V8_POLICIES_JSON` | `{"fetch":{"mode":"all","policies":[{"url":"file:///policies/fetch.rego"}]},"http2":{"policies":[{"url":"file:///policies/http2.rego"}]}}` | Capabilities are **off by default**; a policy chain's presence enables the capability. Mount the rego files from a ConfigMap at `/policies`. |
| `MCP_V8_FETCH_HEADER_CONFIG` | Path to a **Secret-mounted JSON file** (the flag accepts a path or inline JSON — use the file form so tokens stay out of manifests) | Server-side credential injection; see below. |
| `MCP_V8_EXECUTION_TIMEOUT` | e.g. `120` (seconds) | Bound runaway executions. |
| `MCP_V8_HEAP_MEMORY_MAX` | e.g. `512` (MB) | Bound isolate memory. |
| Allowed-hosts flag (check cli.rs; boot logs print "Host header allowlist: …") | `mcp-js.<namespace>.svc.cluster.local` plus any other names clients will dial | DNS-rebinding guard: requests whose Host header isn't allowlisted get **403 "host not allowed"**. This WILL bite on first deploy if unset or wrong. |

Resources: requests ~500m CPU / 1Gi RAM, limits ~2 CPU / 2–4Gi (V8 isolates plus module fetches spike CPU).

### Policies ConfigMap

`fetch.rego` (open egress — tighten later if desired):

```rego
package mcp.fetch

default allow = true
```

`http2.rego` (Modal only — gRPC metadata rides HTTP/2 headers, so keep this host-scoped):

```rego
package mcp.http2

default allow = false

allow if {
    input.operation == "connect"
    input.url_parsed.host == "api.modal.com"
}

allow if {
    input.operation == "request"
    input.authority == "api.modal.com"
}
```

### Header-injection Secret (the Modal connection)

The point of this design: **Modal tokens never enter the sandbox or the JS code.** The server injects them into outbound HTTP/2 streams (gRPC metadata) for the matching host only, and the sandbox has no request-header read-back API, so sandboxed code cannot exfiltrate them.

Create a Secret containing a JSON file shaped like:

```json
[
  {
    "host": "api.modal.com",
    "headers": {
      "x-modal-token-id": "<MODAL_TOKEN_ID>",
      "x-modal-token-secret": "<MODAL_TOKEN_SECRET>"
    }
  }
]
```

Get the real values from the operator (Rob) or your secrets manager — do **not** commit them. Header injection **replaces** same-named headers, so client code passes the real (public) token id and a placeholder secret, and the injected values win.

### Persistence

PVC (a few Gi) mounted at the fs-store path — holds per-session `/work` trees. Note the accepted tradeoff: with `heap-store none`, JS variables do NOT persist across calls within a session — only files under `/work` do. Sandboxed code writes durable state to `/work`.

## Security posture (do not weaken)

This service **executes arbitrary JavaScript and holds credential-injection config**. Treat it like a credential vault with a code-exec API:

- ClusterIP only. No Ingress, no LoadBalancer, no public route of any kind.
- NetworkPolicy: ingress only from the namespaces/pods that legitimately call it; egress open (the sandbox's fetch needs it) or tightened to taste.
- The host-header allowlist (above) is a second guard — keep it exact.
- RBAC: nothing special; it doesn't talk to the k8s API.

## Verification (do all three)

1. **Boot health:** logs show the Streamable HTTP server listening on 8080 and your host allowlist. If you configured upstream MCP servers (`MCP_V8_MCP_CONFIG` — optional, not needed for Modal), expect "All MCP servers connected".

2. **WASM sanity** (proves heap-store none took effect) — from an in-cluster pod:
   ```sh
   curl -s http://mcp-js.<ns>.svc.cluster.local:8080/api/exec \
     -H 'content-type: application/json' \
     -d '{"code":"console.log(typeof WebAssembly)"}'
   ```
   Expect `object`. If `undefined`, heap persistence is still on.

3. **Modal end-to-end** — POST this as the `code` (lists Modal apps over gRPC):
   ```js
   import { ModalClient } from 'npm:modal?target=node';
   import { Buffer } from 'node:buffer';
   import process from 'node:process';
   globalThis.Buffer = Buffer;   // Node-target SDK expects these globals
   globalThis.process = process;
   const modal = new ModalClient({
     tokenId: '<MODAL_TOKEN_ID>',            // real (public) id
     tokenSecret: 'as-injected-server-side', // placeholder — injection replaces it
   });
   const apps = [];
   for await (const app of modal.apps.list()) apps.push(app.name ?? app.appId);
   console.log(JSON.stringify(apps));
   ```
   (If `apps.list()` isn't the exact iteration API in the current SDK, adapt from https://modal.com/docs/sdk/js — the auth/transport path is what's being tested.) Success = a JSON list, no `UNAUTHENTICATED`/`PERMISSION_DENIED`, no TLS panic in server logs.

## Known failure modes (all hit in the reference deployment)

| Symptom | Cause | Fix |
|---|---|---|
| `WebAssembly is not an object` / `typeof WebAssembly === 'undefined'` | Heap persistence on → SnapshotCreator isolate | `MCP_V8_HEAP_STORE=none` |
| `Unknown node builtin module: 'crypto'` | Image older than PR #243 | Rebuild ≥ `27934dc` |
| Rust panic "Could not automatically determine the process-level CryptoProvider" on TLS connect | Same — pre-#243 rustls dual-backend bug | Rebuild ≥ `27934dc` |
| Execution hangs ~30 min then times out; concurrency slots leak until the server starves | Pre-#244 timer unref bugs (gRPC idle timers, WASM SDK keep-alives) | Rebuild ≥ `27934dc` |
| HTTP 403 "host not allowed" on every request | Host allowlist doesn't include the name clients dial | Add the k8s service DNS name to the allowed-hosts flag |
| Modal SDK import pulls a browser build, fails on `node:` imports | Missing esm.sh target hint | Import as `npm:modal?target=node` |
| `--stateless` flag rejected | Stale README | Use `--heap-store none` |

## Deliverables

1. IaC for all resources above, following this repo's conventions, with the Secret wired through the repo's secrets workflow (sealed-secrets / external-secrets / SOPS — whatever is in use), never committed in plaintext.
2. The three verification steps executed, with output reported.
3. A short README next to the resources: what mcp-js is, the heap-store/WASM constraint, and where the header-injection secret comes from.
