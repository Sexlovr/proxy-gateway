// defaultSandbox.js — canonical passthrough for providers with NO sandbox_code.
// OpenAI-compat: forward to upstream's chat completions endpoint, Azure-style.
// Sandbox code shipped for a provider overrides this entirely.

import { parseCompoundKeys } from './keyManager.js';

export async function request(ctx) {
  const { req, res, provider, keys, key, nextKey, fetch, log, signal, stripped } = ctx;

  // ── Body prep ───────────────────────────────────────────────────────────
  // Sandbox receives express.json()'d body. Re-stringify upstream. If `model`
  // field has the prefix still attached (e.g. "ms:zai-org/GLM-5.2"), replace
  // with the stripped bare-name before forwarding.
  const bodyObj = (req.body && typeof req.body === 'object' && !Array.isArray(req.body))
    ? JSON.parse(JSON.stringify(req.body))
    : {};
  if (bodyObj.model && String(bodyObj.model).includes(':')) {
    bodyObj.model = stripped || String(bodyObj.model).split(':').slice(1).join(':');
  }

  const body = ['GET', 'HEAD'].includes(req.method)
    ? undefined
    : Buffer.from(JSON.stringify(bodyObj), 'utf8');

  // ── Headers ────────────────────────────────────────────────────────────────
  const authType = (provider.auth_type || 'bearer').toLowerCase();
  const authHeader = provider.auth_header || 'authorization';
  function buildHeaders(k) {
    const h = Object.assign({}, req.headers);
    for (const k2 of ['content-length', 'host', 'connection', 'accept-encoding']) delete h[k2];
    if (k) {
      if (authType === 'bearer')        h[authHeader] = 'Bearer ' + k;
      else if (authType === 'x-api-key') h['x-api-key'] = k;
      else if (authType === 'basic')     h[authHeader] = 'Basic ' + k;
      else                                h[authHeader] = k;
    } else {
      delete h[authHeader]; delete h['x-api-key'];
    }
    if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
    return h;
  }

  // ── Path: default assumes the upstream is OpenAI-shape so /v1/chat/completions, /v1/messages, etc pass through unmodified ─
  const upstreamPath = req.path || '/';
  const upstreamUrl = provider.upstream_url + upstreamPath;

  // ── Round-robin retry on common saturation codes ───────────────────────
  const retry = [401, 403, 429, 500, 502, 503, 504];
  const skips = [];
  let lastErr = null;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    let k;
    if (attempt === 0) {
      k = key ? String(key).split('|')[0] : null;
    } else {
      const picked = nextKey(skips);
      if (!picked) break;
      k = picked.key;
      skips.push(picked.index);
    }

    const headers = buildHeaders(k);
    const fetchOpts = { method: req.method, headers, body, signal, duplex: 'half' };

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, fetchOpts);
    } catch (e) {
      lastErr = e.message;
      if (attempt + 1 < keys.length) continue;
      if (!res.headersSent) res.status(502).json({ error: { message: 'Upstream fetch failed after ' + (attempt + 1) + ' attempt(s): ' + e.message, type: 'proxy_error' } });
      return;
    }

    if (retry.includes(upstream.status) && attempt + 1 < keys.length) {
      lastErr = 'HTTP ' + upstream.status;
      try { await upstream.body?.cancel(); } catch (_) {}
      continue;
    }

    // ── Forward status + headers (verbatim) ──
    res.status(upstream.status);
    const passthroughSkip = new Set(['transfer-encoding', 'connection', 'keep-alive', 'content-encoding', 'content-length']);
    upstream.headers.forEach((v, hname) => {
      if (passthroughSkip.has(hname.toLowerCase())) return;
      res.setHeader(hname, v);
    });
    if (!res.getHeader('content-type')) {
      res.setHeader('content-type', 'application/json');
    }

    // ── Body = upstream's bytes exactly ──
    if (upstream.body) {
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch (e) {
        try { res.end(); } catch (_) {}
        return;
      }
    }
    res.end();
    return;
  }

  if (!res.headersSent) {
    res.status(502).json({ error: { message: 'All ' + keys.length + ' key(s) for "' + ctx.prefix + '" failed. Last error: ' + (lastErr || 'unknown'), type: 'proxy_error' } });
  }
}
