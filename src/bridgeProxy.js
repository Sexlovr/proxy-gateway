// bridgeProxy.js — the proxy is just a bridge.
//
// One job: take an inbound req, extract the provider prefix from
// req.body.model (e.g. "ms:zai-org/GLM-5.2" -> prefix "ms"),
// look up the provider's sandbox module, hand it a `ctx`, exit.
// Whatever happens upstream↔downstream between two HTTP peers after
// that is the sandbox's responsibility — headers, body, retry, stream,
// encoding, all of it. No legacy compat. No phase machinery. No
// per-phase timeouts. No universal contract. No `__timedOut` sentinels.
// No `{{KEY}}` string injection. No sandbox-VM isolation. If sandbox
// forgot to close `res`, we close it as a grace note for buggy code.
// (see docs/BRIDGE-DESIGN.md)

import { getProvider } from './storage.js';
import { parseCompoundKeys, getNextKey } from './keyManager.js';
import { loadSandbox } from './sandbox.js';
import { openStore } from './kv.js';
import { log, proxyAdminApi } from './log.js';

const DEFAULT_TIMEOUT_MS = 300_000;
const counters = {};

// Plausible inbound client auth-header names. Stripping these from OUTBOUND
// prevents the proxy from leaking a client's own MS key (or an unrelated SDK's
// token-format echo like `anthropic-api-key: <their-claude-key>`) to upstream.
const INBOUND_AUTH_STRIP = [
  'authorization', 'proxy-authorization',
  'x-api-key', 'x-anthropic-api-key', 'anthropic-api-key', 'api-key',
];

function buildStripInboundList(provider, contributedHeaders) {
  const seen = new Set(INBOUND_AUTH_STRIP.map(s => s.toLowerCase()));
  const out = INBOUND_AUTH_STRIP.slice();
  if (Array.isArray(provider.inbound_key_headers)) {
    for (const hn of provider.inbound_key_headers) {
      const k = String(hn).toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(k); }
    }
  }
  if (contributedHeaders) {
    for (const hn of Object.keys(contributedHeaders)) {
      const k = hn.toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(k); }
    }
  }
  return out;
}

export async function handleProxy(req, res) {
  // ── health, dashboard SPA, /api, /sandbox: not us ─────────────────────
  if (req.path.startsWith('/api/') || req.path.startsWith('/v1/models') || req.path.startsWith('/sandbox/')) {
    return; // fallthrough handled by other routers
  }

  // ── 1) Route by body.model {prefix:model_id}  ──────────────────────────
  const body = req && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const modelRaw = String(body.model || '');
  const colonIdx = modelRaw.indexOf(':');
  if (!modelRaw || colonIdx === -1) {
    return res.status(400).json({ error: { message: 'Model field must include a provider prefix, e.g. "ms:zai-org/GLM-5.2"', type: 'proxy_error' } });
  }
  const prefix = modelRaw.slice(0, colonIdx).toLowerCase();
  const strippedModel = modelRaw.slice(colonIdx + 1);

  // ── 2) Look up provider ────────────────────────────────────────────────
  const provider = getProvider(prefix);
  if (!provider) return res.status(404).json({ error: { message: 'No provider registered with prefix "' + prefix + '".', type: 'proxy_error' } });

  // Cloak check (preserves visibility behaviour without legacy compat)
  if (provider.cloaked) return res.status(404).json({ error: { message: 'Not found', type: 'proxy_error' } });

  // ── 3) WIDE-SCAN inbound auth: parse EVERY header for the compound form
  // `<prefix>=<keys-csv>`. No allowlist — anything from Authorization to
  // X-Goog-Api-Key to x-deepseek-key to x-claude-key is accepted, as long as
  // the VALUE contains the `prefix=key1,key2` pattern. This is the future-
  // proof inbound side: future SDKs with weird header names just work.
  //
  // In addition, a per-provider `inbound_key_headers` array may name headers
  // whose bare VALUE is the key (no `prefix=` form required). Useful for
  // closed SDKs that don't know the proxy contract.
  //
  // The bridge NEVER early-401s the client here: it passes whatever it found
  // (possibly `[]`) into ctx, and the SANDBOX owns the upstream auth decision.
  // The default passthrough sandbox emits a 401 itself if it ends up with no
  // keys. Per-provider sandboxes may decide differently (they have raw req.headers
  // via ctx.clientAuth.headers if they want a totally custom auth scheme).
  const compound = {};
  const scanned = {};
  const contributedHeaders = {};        // header-name → true, for headers that YIELDED keys for this prefix
  for (const [hname, hvalRaw] of Object.entries(req.headers)) {
    if (hvalRaw == null) continue;
    const hval = Array.isArray(hvalRaw) ? hvalRaw.join(', ') : String(hvalRaw);
    if (!hval) continue;
    const parsed = parseCompoundKeys(hval);
    scanned[hname] = parsed;
    for (const pfx of Object.keys(parsed)) {
      if (!compound[pfx]) compound[pfx] = [];
      compound[pfx] = compound[pfx].concat(parsed[pfx]);
      if (pfx === prefix) contributedHeaders[hname] = true;     // strip this from OUTBOUND
    }
  }
  let keys = compound[prefix] || [];

  // Provider-configured bare-key headers (e.g. inbound_key_headers: ['x-deepseek-key']).
  if (keys.length === 0 && Array.isArray(provider.inbound_key_headers) && provider.inbound_key_headers.length) {
    for (const hnameRaw of provider.inbound_key_headers) {
      const hname = String(hnameRaw).toLowerCase();
      const v = req.headers[hname];
      if (v == null) continue;
      const strV = Array.isArray(v) ? v.join(', ') : String(v);
      const bare = strV.split('/')
        .map(s => s.trim().replace(/^\s*(Bearer|Basic|Token)\s+/i, '').trim())
        .filter(Boolean);
      if (bare.length) { keys = bare; contributedHeaders[hname] = true; break; }
    }
  }

  // Server-side default (provider.optional_key) — last resort.
  if (keys.length === 0 && provider.optional_key) keys = [provider.optional_key];

  // ── 4) Round-robin pick (no keys? skip — sandbox handles the 401) ──
  let key = null;
  let startIdx = -1;
  if (keys.length > 0) {
    if (!(prefix in counters)) counters[prefix] = 0;
    startIdx = counters[prefix] % keys.length;
    counters[prefix] = (startIdx + 1) % keys.length;
    key = String(keys[startIdx]).split('|')[0];
  }

  // ── 5) AbortSignal — cascade of timeout + client-disconnect ─────────
  // The bridge's signal is a PARENT: any per-attempt signal a sandbox makes
  // via ctx.freshSignal(ms) should derive from this (so the user closing the
  // tab still aborts anything expensive).
  const timeoutMs = provider.default_timeout_ms !== undefined
    ? Number(provider.default_timeout_ms)
    : DEFAULT_TIMEOUT_MS;
  const clientCloseAC = new AbortController();
  let clientClosed = false;
  // Use res.on('close') with a writableEnded gate: Express 4.x fires
  // req.on('close') TOO EARLY (right after body is parsed, before response
  // starts), which would wrongly abort healthy requests. res.on('close')
  // only fires after response completion OR client-disconnect-mid-stream,
  // and gating on `!res.writableEnded` cleanly distinguishes the two.
  res.on('close', () => {
    if (clientClosed || res.writableEnded) return;
    clientClosed = true;
    try { clientCloseAC.abort(new Error('client_disconnected')); } catch (_) {}
  });
  let signal = null;
  const parts = [];
  if (timeoutMs && timeoutMs > 0) {
    try { parts.push(AbortSignal.timeout(timeoutMs)); } catch (_) {}
  }
  parts.push(clientCloseAC.signal);
  if (typeof AbortSignal.any === 'function' && parts.length) {
    try { signal = AbortSignal.any(parts); } catch (_) { signal = parts[parts.length - 1]; }
  } else if (parts.length) {
    signal = parts[parts.length - 1];
  }

  // Per-attempt helper. Pass undefined/null for "no own timeout — just the
  // cascade off client-close". Pass a number for "fresh deadline, also
  // cascading off client-close". Used by sandboxes that do retry across
  // multiple upstream keys and want a clean clock per attempt.
  function freshSignal(ms) {
    if (ms === undefined || ms === null) return clientCloseAC.signal;
    const inner = [];
    try { inner.push(AbortSignal.timeout(Number(ms))); } catch (_) {}
    inner.push(clientCloseAC.signal);
    if (typeof AbortSignal.any === 'function' && inner.length) {
      try { return AbortSignal.any(inner); } catch (_) {}
    }
    return clientCloseAC.signal;
  }

  // ── 6) Build ctx ──────────────────────────────────────────────────────
  const requestId = req.headers['x-request-id'] || Math.random().toString(36).slice(2);
  const ctx = {
    req, res,
    prefix,
    provider,
    model: strippedModel,                                                                  // bare model name, no prefix
    stripped: strippedModel,                                                               // alias
    modelRaw,                                                                              // original "ms:zai-org/GLM-5.2" if needed
    keys,
    key,
    nextKey(skipIdx = []) {
      const skip = new Set([startIdx, ...skipIdx]);
      const picked = getNextKey(prefix, keys, skip);
      if (!picked) return null;
      return { key: picked.key, index: picked.index, proxyUrl: picked.proxyUrl };
    },
    fetch: globalThis.fetch.bind(globalThis),
    store: openStore(prefix),
    proxy: proxyAdminApi,
    log: log.child({ prefix, requestId }),
    signal,
    freshSignal,                                                                           // see §5 above
    clientAuth: {                                                                          // inbound auth introspection for sanboxes
      scanned,                                                                             // { headerName -> parsed compound map }
      contributedHeaders,                                                                   // { headerName -> true } = headers that yielded keys for THIS prefix (strip these from outbound)
      headers: req.headers,                                                                 // raw, all of them
      // Flat strip-list any sandbox can iterate to fully cleanse outbound
      // headers from inbound-plausible-auth-carrying values. Includes the
      // AUTH_HEADER_PREFIXES constant set + provider.inbound_key_headers
      // + headers picked up in the wide compound scan.
      stripInbound: buildStripInboundList(provider, contributedHeaders),
    },
    clientClosed: () => clientClosed,                                                      // read-only leak of disconnect state
  };

  // ── 7) Load sandbox (inline code, file slug, OR default passthrough) ─
  let sandbox;
  try {
    sandbox = await loadSandbox(provider);
  } catch (err) {
    log.error({ prefix, err: err.message, stack: err.stack }, 'sandbox load error');
    if (!res.headersSent) res.status(500).json({ error: { message: 'Sandbox failed to load: ' + err.message, type: 'sandbox_load_error' } });
    return;
  }

  // ── 8) Hand off ────────────────────────────────────────────────────────
  try {
    await sandbox.request(ctx);
    if (!res.headersSent) {
      log.warn({ prefix, requestId }, 'sandbox returned without writing any response (closing connection)');
      res.status(204).end();
    } else if (!res.writableEnded) {
      res.end();
    }
  } catch (err) {
    if (res.headersSent) {
      // Mid-stream error: best-effort trailer. We deliberately do not
      // include the raw err.message — in upstream-validation paths it
      // can contain secret material (rejected header values, API keys,
      // auth echoes). A neutral trailer is safer and the structured log
      // already has the full message for internal inspection.
      try { res.write('\n[data: sandbox-error: see proxy logs]\n'); } catch (_) {}
      try { res.end(); } catch (_) {}
    } else {
      log.error({ prefix, requestId, err: err.message, stack: err.stack }, 'sandbox request threw');
      res.status(500).json({ error: { message: 'Sandbox error: ' + err.message, type: 'sandbox_error' } });
    }
  }
}
