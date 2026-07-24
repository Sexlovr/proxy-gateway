# Bridge-Design — proxy-gateway v2 contract

> Goal of the rewrite: a "router where you plug in any provider, normal or
> not, and define its full behaviour by editing one .js file from the
> dashboard. The proxy itself stops doing request shaping, response shaping,
> retry logic, streaming reframing, key injection, or sandbox-VM isolation.
> All of that moves into the per-provider sandbox file. The proxy becomes
> nothing more than a *bridge*: prefix-strrip + lookup + req/res hand-off +
> storage plumbing. Limitations only come from hardware, never from this
> proxy."

## One-sentence contract

> ```js
> // sandboxes/<name>.js  (OR provider.sandbox_code, your call).
> // Run as ordinary Node ES Modules — no VM isolation, no per-phase wrapper.
> module.exports = async function request(ctx) {
>   const upstream = await ctx.fetch(ctx.provider.upstream_url + ctx.req.path,
>       { method: ctx.req.method, headers: ctx.req.headers,
>         body: ['GET','HEAD'].includes(ctx.req.method) ? undefined : req.body,
>         duplex: 'half' });
>   ctx.res.status(upstream.status);
>   upstream.headers.forEach((v, k) => ctx.res.setHeader(k, v));
>   if (upstream.body) for await (const chunk of upstream.body) ctx.res.write(chunk);
>   ctx.res.end();
> };
> ```

That's it. The entire universal contract is one async function. It takes a
`ctx`, does whatever it wants (one upstream call, multi-hop, parallel
fan-out, retry with another key, bidirectional pipe), and ends the
`ctx.res` itself. When `request(ctx)` resolves or throws, the proxy's work
for that request is over.

## `ctx` shape (everything the sandbox receives)

```js
{
  // ── raw Express primitives ────────────────────────────────────────────
  req:    <express.Request>,        // Use req.path, req.method, req.headers, req.body (parsed JSON), req ip. Body is express.json()'d by server.js, so a Buffer copy is in req.rawBody for sandbox when needed.
  res:    <express.Response>,       // Sandbox owns this end-to-end. Use res.status(), res.setHeader(), res.write(), res.end(), res.json(), res.sendFile(), etc.

  // ── provider identity ───────────────────────────────────────────────
  prefix:    <string>,               // "ms" / "gm" / "crmsn" / ...
  provider:  <provider row from storage>,   // raw { prefix, name, upstream_url, auth_type, auth_header, models_endpoint, sandbox_code, sandbox_file, allowed_hosts, think_config, search_config, cloaked, ... }
  stripped:  <Attempted input URL after prefix strip>, // path-only, no leading slash from the original `/ms/...` path so sandbox can reuse as-is

  // ── keys (round-robin, failover) ─────────────────────────────────────
  keys:    <Array<string>>,          // Full array of raw keys the client passed for this prefix, parsed out of `Authorization: ms=key1,key2` style. Sandbox chose rotation itself.
  key:     <string|null>,            // First key (round-robin pointer used by homeworked rotator). Sandbox can ignore and use keys[0] etc.
  nextKey: <fn(skipIdx=[]) → {key, index}>,   // Pull next key in rotation (proxy guarantees round-robin fairness across requests). Skip-set optional.

  // ── HTTP helper ───────────────────────────────────────────────────────
  fetch:    <globalThis.fetch>,      // same as Node 22's global undici fetch; sandbox can use raw `http`/`https`/`net`/`ws` via require too.

  // ── per-provider KV (file-backed, persists between calls) ──────────
  store: {
    get(keyPath): Promise<Buffer|null>,
    set(keyPath, value: Buffer|string|JSON-able): Promise<void>,
    del(keyPath): Promise<void>,
    list(prefix?): Promise<string[]>,
  },                                // one namespace per provider.prefix. Used for rate-limit cooldowns, model cache, session token holders.

  // ── call-back into the proxy admin (sandbox controls the proxy) ────
  proxy: {
    listProviders():          Promise<Array>,
    getProvider(prefix):     Promise<Object|null>,
    addProvider(cfg):        Promise<{ok, reason?}>,
    updateProvider(prefix, patch): Promise<{ok, changes?, reason?}>,
    deleteProvider(prefix):  Promise<{ok, reason?}>,
    rotateKeys(prefix, opts): Promise<Array<string>>,   // e.g. { dropIdx: [..], promoteWaitlist: false }
    log(level, message, meta?): Promise<void>,   // structured logger into the proxy's stdout
    stats(prefix, patch):   Promise<void>,        // bump --proxy never rate-limits off of this.
    schedule(name, every_ms, fn): Promise<task>, // background recurring fn that survives across requests. fn runs lazily, sees ctx for that scheduled invocation only. Use ctx.proxy... from inside.
    spawnTask(fn):           Promise,             // fire-and-forget after res.end() (audit log / queue drain); exit at sandbox's discretion.
  },

  // ── logger ───────────────────────────────────────────────────────────
  log:    <pino-style logger bound to { prefix, requestId }>,

  // ── lifecycle abort (hardware-only limit, can be left alone) ───────
  signal: <AbortSignal default 5min — sandbox can pass into fetch/any-slow-asfujus. Falsy means no abort, see Discussion below.>
}
```

## What the proxy keeps

- Express `app.listen()` on `PORT` (=7860 by default). Server.js gets a brief top-level import of `bridgeProxy.handleProxy` and admin routers. That's it.
- Prefix-strrip middleware that extracts leading `/\<prefix\>/` segment, drops the prefix segment from the inbound URL the sandbox sees, looks up providers by that prefix — if not found return 404.
- Express body-parser for JSON / raw (multi-megabyte cap inherited from today).
- Admin endpoints under `/api/providers/*`, `/api/models/*`, `/api/stats/*`, `/api/sandbox/*` — unchanged from current behaviour.
- Provider config store (`src/storage.js`) — on disk at `/app/data/providers.json`.
- Per-provider file-backed KV (`src/kv.js` new). Simple JSON file per prefix under `/app/data/kv/<prefix>/`.
- Sandbox module loader + hot-reload (`src/sandbox.js` new). Reads `provider.sandbox_code` (if non-empty) and `eval`s once at first use; loads `provider.sandbox_file` as a `require()` of `./sandboxes/<file>` if set; falls through to the built-in default passthrough `src/defaultSandbox.js` if neither exists.
- Stats accumulator + dashboard (the dashboard also keeps listing/cloaked reveal).
- Structured stdout/stderr logging (`src/log.js` new, optional).

## What the proxy stops doing

Everything that used to live in `src/proxy.js` (~`974 LOC`), `src/sandboxRunner.js` (~`665 LOC`), `src/transformer.js`, `src/sandboxLoader.js`, `src/sandboxFetch.js`, `src/features.js` — and the entire "universal contract" lattice of escape hatches (`upstream_stream_format`, `downstream_stream_format`, `downstream_content_type`, `trail_done`, `stream_error_trailer`, `endpoint_type`, `hijack`, `passthrough`, `next_request`, `retry_codes`, `endpoint_type`, `optional_key`, plus the prior bugs those primitives caused).

That's ~`2200 LOC` replaced by ~`250 LOC` total across bridgeProxy.js + sandbox.js + defaultSandbox.js + kv.js.

## Default passthrough (`src/defaultSandbox.js`)

If the provider has no `sandbox_code` and no `sandbox_file`, the proxy uses this canonical default, so providers like the 17 legacy ones (`crmsn`, `gm`, `atxp`, ...) keep behaving identically without any action:

```js
import { handleProxy helper thought about } from './sandbox-helpers.js';

export default async function defaultSandbox(ctx) {
  const path = ctx.req.path;          // Assume the proxy has already stripped the prefix
  const body = ['GET','HEAD'].includes(ctx.req.method) ? undefined
              : ((typeof ctx.req.body === 'string') ? ctx.req.body
                  : JSON.stringify(ctx.req.body || {}));

  // ── Auth injection based on provider.auth_type / auth_header ──
  const headers = Object.assign({}, ctx.req.headers);
  delete headers['content-length'];
  if (ctx.key) {
    const ah = ctx.provider.auth_header || 'authorization';
    if ((ctx.provider.auth_type || 'bearer').toLowerCase() === 'bearer')      headers[ah] = 'Bearer ' + ctx.key;
    else if (ctx.provider.auth_type.toLowerCase() === 'x-api-key')            headers['x-api-key'] = ctx.key;
    else                                                                      headers[ah] = ctx.key;
  }

  // ── Round-robin retry on the common "saturation" status codes ──
  const retry = [401, 403, 429, 500, 502, 503, 504];
  let picked, attempts = 0;
  while (attempts < Math.max(1, ctx.keys.length)) {
    picked = attempts === 0 ? ctx.key : ctx.nextKey(attempts === 1 ? null : null)?.key;
    if (picked) headers[ctx.provider.auth_header || 'authorization'] = (ctx.provider.auth_type || 'bearer').toLowerCase() === 'bearer' ? ('Bearer ' + picked)
                              : picked;
    const upstream = await ctx.fetch(ctx.provider.upstream_url + path, {
      method: ctx.req.method, headers, body,
      signal: ctx.signal, duplex: 'half',
    });
    if (retry.includes(upstream.status) && attempts + 1 < ctx.keys.length) {
      attempts++; continue;
    }
    ctx.res.status(upstream.status);
    upstream.headers.forEach((v, k) => { if (['transfer-encoding','content-length','content-encoding','connection'].includes(k.toLowerCase())) return; ctx.res.setHeader(k, v); });
    if (upstream.body) for await (const chunk of upstream.body) ctx.res.write(chunk);
    ctx.res.end();
    return;
  }
}
```

The default does what 80% of the existing 17 legacy providers were doing implicitly (OpenAI-compat bearer passthrough to their `upstream_url`). Anything fancier is up to your own sandbox code.

## Provider shape to add (unchanged for the admin)

The dashboard and `/api/providers` continue accepting the same fields. `sandbox_code` continues to be an executable string. `sandbox_file` continues to be `"name.js"` (resolved to `./sandboxes/<name>.js`). Empty if you want the default. Add-on fields that the bridge layer can add later don't break the store:

- `flags.warn_browser_gets_buffered` (boolean) — informational, optional.
- `default_timeout_ms` (number) — overrides the 5-minute cap if you want longer or shorter, passed into `ctx.signal = AbortSignal.timeout(...)` for that request.

## Telling the old universal contract apart from the new one

There is NO old universal contract any more — the rewrite is a single-bazooka gut. The migration is:

| Old universal return field | New place to do that work |
| --- | --- |
| `request().url`, `url_path`, `method`, `headers`, `body` | sandbox builds the URL/options and calls `ctx.fetch` directly |
| `request().upstream_stream_format`, `downstream_stream_format`, `downstream_content_type`, `trail_done`, `stream_error_trailer` | sandbox writes the `res` exactly how it wants — SSE frames, raw, JSON carcass, no trailer, custom trailer, anything; or use `proxy-helpers.js` stream helpers |
| `request().retry_codes`, `skipped`, `lastError` | sandbox wraps its own retry loop, iterates `ctx.keys`, decides when to fail out |
| `request().endpoint_type`, `hijack`, `passthrough`, `next_request` chain-poll | gone — sandbox just does the chain itself with multiple awaits |
| `request().{{KEY}}` substitution | gone — sandbox has the raw key string in `ctx.key` already |
| response/stream_chunk/stream_end phases | gone — sandbox owns res full-pipe |
| `provider.sandbox` (legacy `function(req, features, provider, ctx)` form, deeply nested in `transformer.js`) | gone — migrate these files to the new `module.exports = async function request(ctx) {}` shape; quick for the existing 17 because default covers them |
| features parsing (`[low]`, `[high]`, `[search]` tags in message content; `x-proxy-features` header) | each provider sandbox parses its own body for the tags it cares about. If you wrote e.g. `gm:` and want your `gm:gemini-2.5-flash-high` shortcut, your `gm` sandbox parses `-high` suffix itself. Helper still ships in `src/sandbox-helpers.js` for DRY. |

Each of the 17 live providers either gets a tiny <30-line JS file in `sandboxes/` if it needs custom shaping, or stays on the default-passthrough one. There is no in-place migration to do beyond `modelscope.js` (we'll port it live).

## Hardware boundaries (only limits left)

- HF Space container CPU: ~2 vCPU shared (fine for ~100s of concurrent `await fetch()` since Node releases CPU between awaits).
- HF Space container RAM: 16GB (single Node process). No artificial cap on concurrent requests from the proxy.
- Disk under `/app` is ephemeral (sandbox-written `ctx.store` keys reset on factory rebuild — re-pull from upstream on first call after restart if you need cached data).
- `AbortSignal.timeout(300000)` default — 5 min. Configurable via `provider.default_timeout_ms`. Setting `0` or `null` disables entirely (no proxy limit) leaving only TCP/socket keepalive (~ OS manage).
- Sandbox code gets full Node stdlib (`require('net')`, `require('ws')`, `require('child_process')`, `require('fs')`, anything in `package.json` deps of the proxy). Sandbox code runs in the proxy's own `module` scope — same permissions as the proxy itself.
- Anyone who can write a sandbox file or POST `/api/providers` with sandbox_code has effective shell on the proxy container. If you set a `PR0XY_ADMIN` env var with a password, the `/api/providers/*` write endpoints require it (today's `verifyPassword` mech).

## Why this is the right time (and how it survives today)

- The 2 bugs we hit porting `modelscope.js` this morning (`__timedOut` sentinel at `sandboxRunner.js:484`, the `for-in` over `Headers` prototype at `proxy.js:549-551`) become structurally impossible under the new code — the proxy doesn't do either of those things anymore.
- Each sandbox becomes maybe 20–60 lines, readable at a glance.
- The dashboard code-edit field already accepts sandbox_code strings; minimal UI change needed (mostly cosmetic — pick a placeholder + an example template file in `public/scripts/pages/sandbox.js`.
