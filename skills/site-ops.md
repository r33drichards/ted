# Skill: robw.fyi site operations

The WordPress site https://www.robw.fyi is hosted on Wasmer (app "wordpress-sm7xo", id `da_nQgIotrUdGZW`, owner r33drichards). Three access paths, in order of preference:

1. **WP REST API** (site healthy): `fetch()` from run_js to `https://www.robw.fyi/wp-json/wp/v2/...` is auto-authenticated as admin `r33drichards` — never add an Authorization header. Use for posts, pages, plugins, users, settings.
2. **Volume filesystem** (works even when the site is 500ing): from run_js, `await mcp.callTool("wpfs", "wp_list"|"wp_read"|"wp_write"|"wp_delete", {path|prefix, content?})` — paths relative to `wp-content/`. The same ops exist as the direct `wp_fs` tool if the sandbox itself is unavailable. This is the disaster-recovery path.
3. **Wasmer platform API**: `fetch()` to `https://registry.wasmer.io/graphql` is auto-authenticated. Redeploy after PHP file changes:
   `mutation { redeployActiveVersion(input: {id: "da_nQgIotrUdGZW"}) { app { activeVersion { id } } } }`

Hard rules, learned from a real outage:

- **Never write to `wp-content/mu-plugins/` without validating the PHP syntax first.** mu-plugins execute before everything on every request; one syntax error 500s the whole site including the REST API you'd use to fix it. Prefer a normal plugin, and dry-run new PHP where a failure is contained.
- **PHP opcache keeps executing deleted/changed files until the app is redeployed.** After changing any PHP file: redeploy via the Wasmer mutation, then re-verify with a fresh request. A change that "didn't take" usually means you skipped this.
- **Code Snippets "run everywhere" snippets execute on every page load** — a snippet that writes files will recreate them after you delete them. Disable/delete the snippet before cleaning up its artifacts.
- **After any risky change, verify**: fetch `https://www.robw.fyi/` and `/wp-json/` and expect 200s. On a 500: inspect and revert the most recent change via wpfs, redeploy, verify again. Report honestly what broke and what you did.

Telemetry:

- The site exports OTel to `https://otel-lgtm-production-ee87.up.railway.app` (paths `/v1/traces`, `/v1/metrics`, `/v1/logs`); the in-project collector is `http://otel-lgtm.railway.internal:4318`.
- Query telemetry from run_js via `mcp.callTool("grafana", ...)` — e.g. `list_datasources`, `query_prometheus`, `query_loki_logs`, `search_dashboards`. Discover all bridged MCP servers/tools at runtime with `mcp.servers` and `mcp.listTools()`.
