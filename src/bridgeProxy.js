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

  // ── 3) Parse `<prefix>=<keys-csv>` or fallback to bare Bearer ─────────
  // Accept keys from Authorization: Bearer ... OR Anthropic-style headers
  // (x-api-key / x-anthropic-api-key / anthropic-api-key). Claude Code uses
  // x-api-key by default; OpenAI-style clients use Authorization: Bearer.
  const rawAuth = req.headers['authorization'] || '';
  const rawKeyHdr = req.headers['x-api-key'] || req.headers['x-anthropic-api-key'] || req.headers['anthropic-api-key'] || '';
  const rawAuthAny = rawAuth || rawKeyHdr;
  const compound = parseCompoundKeys(rawAuth);
  if (rawKeyHdr) Object.assign(compound, parseCompoundKeys(rawKeyHdr));
  let keys = compound[prefix] || [];
  if (keys.length === 0 && rawAuth.replace(/^\s*(Bearer|Basic|Token)\s+/i, '').trim()) {
    keys = [rawAuth.replace(/^\s*(Bearer|Basic|Token)\s+/i, '').trim()];
  }
  if (keys.length === 0 && rawKeyHdr.replace(/^\s*(Bearer|Basic|Token)\s+/i, '').trim()) {
    keys = [rawKeyHdr.replace(/^\s*(Bearer|Basic|Token)\s+/i, '').trim()];
  }
  if (keys.length === 0 && provider.optional_key) keys = [provider.optional_key];
  if (keys.length === 0) {
    return res.status(401).json({ error: { message: 'No API keys for prefix "' + prefix + '". Send keys as: Authorization: Bearer ' + prefix + '=key1,key2 (or x-api-key: ' + prefix + '=key1,key2 for Anthropic-style clients)', type: 'auth_error' } });
  }

  // ── 4) Round-robin pick ────────────────────────────────────────────────
  if (!(prefix in counters)) counters[prefix] = 0;
  const startIdx = counters[prefix] % keys.length;
  counters[prefix] = (startIdx + 1) % keys.length;
  const key = keys[startIdx].split('|')[0];

  // ── 5) AbortSignal (hardware-level ceiling; 0/null disables) ─────────
  const timeoutMs = provider.default_timeout_ms !== undefined
    ? Number(provider.default_timeout_ms)
    : DEFAULT_TIMEOUT_MS;
  let signal = null;
  if (timeoutMs && timeoutMs > 0) {
    try { signal = AbortSignal.timeout(timeoutMs); } catch (_) { signal = null; }
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
