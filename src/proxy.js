// proxy.js
//
// Universal proxy. Three operating modes (auto-detected per request):
//
//   1. NO SANDBOX             - default OpenAI chat/completions passthrough
//   2. LEGACY sandbox_code    - request-phase rewrite with hardcoded chat.completion output shaping
//   3. UNIVERSAL sandbox_code - sandbox fully owns request, upstream fetch, response, stream
//                                  framing, and downstream payload. Proxy is a thin runtime.
//
// Detection:
//   - runSandboxCodeV2 first attempts to create a session from provider.sandbox_code (or sandbox_file).
//   - If a session is created, sandbox declares universal via `universal:true` or by exposing
//     request/response/stream_chunk functions; we route into the universal handler.
//   - Otherwise (no code, or code uses the old positional signature) we fall back to the
//     legacy single-phase flow preserved from the original implementation.

import vm from 'vm';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { getProvider } from './storage.js';
import { parseCompoundKeys, getNextKey } from './keyManager.js';
import { transformRequest, injectKey } from './transformer.js';
import { recordProxyRequest } from './stats.js';
import { runSandboxCode, createSandboxSession } from './sandboxRunner.js';
import { getSandboxCode } from './sandboxLoader.js';

// === LEGACY helpers — preserved for chat-completion output shaping ==================
function parseGeminiChunk(data) {
  try {
    var g = JSON.parse(data);
    if (!g.candidates || !g.candidates[0] || !g.candidates[0].content) return null;
    var parts = g.candidates[0].content.parts;
    var text = '';
    for (var i = 0; i < parts.length; i++) if (parts[i].text) text += parts[i].text;
    return text || null;
  } catch (e) { return null; }
}

function parseAnthropicChunk(data, eventType) {
  try {
    var a = JSON.parse(data);
    if (eventType === 'content_block_delta') return (a.delta && (a.delta.text || a.delta.thinking)) || null;
    return null;
  } catch (e) { return null; }
}

function parseGeminiFull(responseBody) {
  try {
    var g = JSON.parse(responseBody);
    var text = '';
    if (g.candidates && g.candidates[0] && g.candidates[0].content && g.candidates[0].content.parts) {
      for (var i = 0; i < g.candidates[0].content.parts.length; i++) {
        var p = g.candidates[0].content.parts[i];
        if (p.text) text += p.text;
      }
    }
    return text;
  } catch (e) { return null; }
}

function parseAnthropicFull(responseBody) {
  try {
    var a = JSON.parse(responseBody);
    var text = '';
    if (a.content && Array.isArray(a.content)) {
      for (var i = 0; i < a.content.length; i++) {
        if (a.content[i].type === 'text') text += a.content[i].text;
        if (a.content[i].type === 'thinking') text += a.content[i].thinking;
      }
    }
    return text;
  } catch (e) { return null; }
}

function compileCustomParser(parserStr) {
  if (!parserStr || typeof parserStr !== 'string') return null;
  try {
    var code = 'var __parser = ' + parserStr.trim() + ';';
    var ctx = vm.createContext({ JSON: JSON, Array: Array, Object: Object, String: String, Number: Number, Math: Math, parseInt: parseInt, parseFloat: parseFloat, isNaN: isNaN, Date: Date, RegExp: RegExp });
    var script = new vm.Script(code);
    script.runInContext(ctx, { timeout: 1000 });
    if (typeof ctx.__parser === 'function') {
      return function (data, eventType) {
        try {
          ctx.__data = data;
          ctx.__event = eventType || '';
          var runScript = new vm.Script('__result = __parser(__data, __event);');
          runScript.runInContext(ctx, { timeout: 500 });
          return ctx.__result || null;
        } catch (e) { return null; }
      };
    }
    return null;
  } catch (e) { return null; }
}

var proxyAgentCache = new Map();
function getProxyAgent(url) {
  if (!proxyAgentCache.has(url)) proxyAgentCache.set(url, new ProxyAgent(url));
  return proxyAgentCache.get(url);
}

// Build allowlist of hosts the sandbox fetch can reach.
function buildAllowedHosts(provider) {
  var list = [];
  if (provider && provider.upstream_url) {
    try { list.push(new URL(provider.upstream_url).hostname); } catch (e) {}
  }
  if (provider && Array.isArray(provider.allowed_hosts)) {
    for (var i = 0; i < provider.allowed_hosts.length; i++) {
      if (list.indexOf(provider.allowed_hosts[i]) === -1) list.push(provider.allowed_hosts[i]);
    }
  }
  return list;
}

// Resolve the active sandbox code for a provider (inline string OR file under ./sandboxes/).
function resolveSandboxCode(provider) {
  if (provider.sandbox_file) {
    var fetched = getSandboxCode(provider.sandbox_file);
    if (fetched) {
      if (fetched.error) return { code: null, error: fetched.error };
      return { code: fetched.code, error: null };
    }
  }
  if (provider.sandbox_code) return { code: provider.sandbox_code, error: null };
  return { code: null, error: null };
}

// === MAIN PROXY ENTRY =======================================================
export async function handleProxy(req, res) {
  var ip = req.headers['x-forwarded-for']
    ? req.headers['x-forwarded-for'].split(',')[0].trim()
    : (req.socket ? req.socket.remoteAddress : 'unknown') || 'unknown';
  var body = req.body || {};
  var modelRaw = body.model || '';
  var colonIdx = modelRaw.indexOf(':');

  if (!modelRaw || colonIdx === -1) {
    recordProxyRequest(null, ip, true);
    return res.status(400).json({ error: { message: 'Model field must include a provider prefix, e.g. "opn:gpt-4o"', type: 'proxy_error' } });
  }

  var prefix = modelRaw.slice(0, colonIdx).toLowerCase();
  var strippedModel = modelRaw.slice(colonIdx + 1);
  var provider = getProvider(prefix);

  if (!provider) {
    recordProxyRequest(prefix, ip, true);
    return res.status(404).json({ error: { message: 'No provider registered with prefix "' + prefix + '".', type: 'proxy_error' } });
  }

  var authHeader = req.headers['authorization'] || '';
  var allKeys = parseCompoundKeys(authHeader);
  var providerKeys = allKeys[prefix] || [];
  if (providerKeys.length === 0 && provider.optional_key) providerKeys.push(provider.optional_key);
  if (providerKeys.length === 0) {
    recordProxyRequest(prefix, ip, true);
    return res.status(401).json({ error: { message: 'No API keys for prefix "' + prefix + '". Send keys as: Authorization: Bearer ' + prefix + '=key1,key2', type: 'auth_error' } });
  }

  // Try UNIVERSAL path first
  var resolved = resolveSandboxCode(provider);
  if (resolved.error) res.setHeader('x-sandbox-error', resolved.error);

  var session = null;
  if (resolved.code) {
    var allowedHosts = buildAllowedHosts(provider);
    session = createSandboxSession(resolved.code, {
      req: body,
      features: {}, // legacy features are parsed by transformRequest - we pass through empty for v2 path
      provider: provider,
      context: {
        path: req.path,
        method: req.method || 'POST',
        original_model: modelRaw,
        stripped_model: strippedModel,
      },
      stream: body.stream === true,
      allowedHosts: allowedHosts,
      perRequestTimeout: 30000,
      perFetchTimeout: 30000,
      maxConcurrent: 5,
      maxChain: 10,
      maxBytes: 50 * 1024 * 1024,
      log: function (msg) { console.log(msg); },
    });
  }

  if (session && !session.error) {
    return universalHandler(req, res, provider, prefix, strippedModel, modelRaw, providerKeys, ip, session, body);
  }

  // LEGACY path (no sandbox OR sandbox uses old contract)
  return legacyHandler(req, res, provider, prefix, strippedModel, providerKeys, ip, body);
}

// === UNIVERSAL HANDLER ======================================================
async function universalHandler(req, res, provider, prefix, strippedModel, modelRaw, providerKeys, ip, session, incomingBody) {
  var clientWantsStream = incomingBody.stream === true;
  var skipped = new Set();
  var lastError = null;

  // PHASE 1: request
  var reqResult = await session.dispatchRequest();
  if (!reqResult) reqResult = {}; // sandbox didn't define request phase - use defaults below
  if (reqResult.__timedOut) {
    res.setHeader('x-sandbox-error', 'request phase timed out');
    return res.status(500).json({ error: { message: 'sandbox request phase timed out', type: 'proxy_error' } });
  }

  // Hijack: sandbox fully owns response. We stop here.
  if (reqResult.hijack) {
    recordProxyRequest(prefix, ip, false, reqResult.endpoint_type || null);
    session.dispose();
    return;
  }

  // Stream intent
  var streamIntent = (typeof reqResult.stream === 'boolean') ? reqResult.stream : clientWantsStream;
  var upstreamStreamFormat = reqResult.upstream_stream_format || null;
  var downstreamStreamFormat = reqResult.downstream_stream_format
    || upstreamStreamFormat
    || 'raw';

  // Retry codes (replace mode by default in V2; merge if mode == 'merge')
  var retryCodes = [401, 403, 429];
  if (Array.isArray(reqResult.retry_codes)) {
    if (reqResult.retry_codes_mode !== 'merge') {
      retryCodes = reqResult.retry_codes;
    } else {
      for (var rcx = 0; rcx < reqResult.retry_codes.length; rcx++) {
        if (retryCodes.indexOf(Number(reqResult.retry_codes[rcx])) === -1) retryCodes.push(Number(reqResult.retry_codes[rcx]));
      }
    }
  }

  var customTimeout = reqResult.timeout_ms || 300000;
  var endpointType = reqResult.endpoint_type || null;
  const MAX_CHAIN = 10;
  var chainCount = 0;
  // The "current" request descriptor; may be mutated by next_request chain-poll results.
  var requestDescriptor = buildRequestDescriptor(reqResult, provider, req);

  // Build multipart body if requested
  function buildMultipartBody(form, key) {
    var boundary = '----sandbox' + cryptoBoundary();
    var parts = [];
    for (var i = 0; i < form.length; i++) {
      var f = form[i];
      parts.push('--' + boundary + '\r\n');
      if (f.filename) {
        parts.push('Content-Disposition: form-data; name="' + f.name + '"; filename="' + f.filename + '"\r\n');
        parts.push('Content-Type: ' + (f.contentType || 'application/octet-stream') + '\r\n\r\n');
        if (f.body instanceof Buffer) parts.push(f.body);
        else if (typeof f.body === 'string') parts.push(Buffer.from(f.body));
        else parts.push(Buffer.from(String(f.body)));
        parts.push(Buffer.from('\r\n'));
      } else {
        parts.push('Content-Disposition: form-data; name="' + f.name + '"\r\n\r\n');
        parts.push(Buffer.from(String(f.value) + '\r\n'));
      }
    }
    parts.push(Buffer.from('--' + boundary + '--\r\n'));
    var body = Buffer.concat(parts.map(function (p) { return p instanceof Buffer ? p : Buffer.from(p); }));
    return { body: body, contentType: 'multipart/form-data; boundary=' + boundary };
  }

  function cryptoBoundary() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // Returns { requestDescriptor, streamIntent, upstreamStreamFormat, downstreamStreamFormat,
  //          retryCodes, customTimeout, endpointType } from a phase result.
  function buildRequestDescriptor(phaseResult, provider, req) {
    var baseHeaders = phaseResult.headers;
    if (!baseHeaders) {
      baseHeaders = {};
      var authType = (provider.auth_type || 'bearer').toLowerCase();
      var authHeaderName = provider.auth_header || 'authorization';
      if (authType === 'bearer') baseHeaders[authHeaderName] = 'Bearer {{KEY}}';
      else if (authType === 'x-api-key') baseHeaders['x-api-key'] = '{{KEY}}';
      else baseHeaders[authHeaderName] = '{{KEY}}';
      baseHeaders['content-type'] = 'application/json';
    }
    return {
      url: phaseResult.url || null,
      url_path: phaseResult.url_path || null,
      method: (phaseResult.method || req.method || 'POST').toUpperCase(),
      headers: baseHeaders,
      body: phaseResult.body,
      is_multipart: !!phaseResult.is_multipart,
      form: phaseResult.form || null,
      raw_body_buffer: phaseResult.raw_body_buffer instanceof Buffer ? phaseResult.raw_body_buffer : null,
    };
  }

  // Inner loop: try each key (rotation/retry)
  while (true) {
    var picked = getNextKey(prefix, providerKeys, skipped);
    if (!picked) break;
    var key = picked.key;
    var index = picked.index;

    // Apply key to headers and url
    var headers = injectKey(requestDescriptor.headers, key);
    var upstreamUrl = requestDescriptor.url
      ? requestDescriptor.url.replace(/{{KEY}}/g, encodeURIComponent(key)).replace(/{{KEYRAW}}/g, key)
      : provider.upstream_url + (requestDescriptor.url_path || req.path);

    var fetchOpts = {
      method: requestDescriptor.method,
      headers: headers,
      signal: AbortSignal.timeout(customTimeout),
    };
    if (fetchOpts.method !== 'GET' && fetchOpts.method !== 'HEAD') {
      if (requestDescriptor.is_multipart && Array.isArray(requestDescriptor.form)) {
        var mb = buildMultipartBody(requestDescriptor.form, key);
        headers['content-type'] = mb.contentType;
        fetchOpts.body = mb.body;
      } else if (requestDescriptor.raw_body_buffer instanceof Buffer) {
        fetchOpts.body = requestDescriptor.raw_body_buffer;
      } else if (requestDescriptor.body !== undefined && requestDescriptor.body !== null) {
        if (typeof requestDescriptor.body === 'string') fetchOpts.body = requestDescriptor.body;
        else fetchOpts.body = JSON.stringify(requestDescriptor.body);
      }
    }

    if (picked.proxyUrl) {
      fetchOpts.dispatcher = getProxyAgent(picked.proxyUrl);
      console.log('[proxy-universal] routing through forward proxy for key index ' + index);
    }

    var upstream;
    try {
      upstream = await undiciFetch(upstreamUrl, fetchOpts);
    } catch (err) {
      skipped.add(index);
      lastError = err.message;
      continue;
    }

    if (retryCodes.indexOf(upstream.status) !== -1) {
      skipped.add(index);
      lastError = 'Key #' + (index + 1) + ' returned ' + upstream.status;
      continue;
    }

    // Detected streaming upstream?
    var contentType = upstream.headers.get('content-type') || '';
    var isSSE = contentType.indexOf('text/event-stream') !== -1
      || (upstreamStreamFormat === 'sse')
      || contentType.indexOf('application/x-ndjson') !== -1
      || (upstreamStreamFormat === 'ndjson')
      || (upstreamStreamFormat === 'json_lines');

    // Branch: streamed vs non-streamed, with sandbox as final arbiter of downstream shape.
    try {
      if (streamIntent && (isSSE || upstreamStreamFormat)) {
        await universalStreamDownstream(req, res, session, upstream, prefix, ip, strippedModel, modelRaw,
          upstreamStreamFormat, downstreamStreamFormat, clientWantsStream);
      } else {
        var result = await universalBufferedDownstream(req, res, session, upstream, prefix, ip, strippedModel, modelRaw, true);

        // Chain-poll: if sandbox returned { next_request: {...} }, we dispatch another upstream call
        // using the new request descriptor, then run the response phase again.
        //
        // Why this is useful: async image gen endpoints (POST /generation -> poll /status/{id})
        // can be expressed simply:
        //   response: function(ctx) {
        //     if (ctx.upstream.bodyJson.status === 'pending') {
        //       return { passthrough: false, next_request: { url_path: '/status/' + ctx.upstream.bodyJson.id } };
        //     } else {
        //       return { passthrough: false, body: ctx.upstream.bodyJson };
        //     }
        //   }
        //
        // The proxy continues, keeping the same key, until sandbox stops returning next_request.
        while (result && result.next_request && chainCount < MAX_CHAIN && !skipped.has(index)) {
          chainCount++;
          var nextReq = result.next_request;
          var nextDescriptor = buildRequestDescriptor(nextReq, provider, req);
          // Allow streaming intent changeover per hop
          if (typeof nextReq.stream === 'boolean') streamIntent = nextReq.stream;
          if (nextReq.upstream_stream_format) upstreamStreamFormat = nextReq.upstream_stream_format;
          if (nextReq.downstream_stream_format) downstreamStreamFormat = nextReq.downstream_stream_format;

          var nextHeaders = injectKey(nextDescriptor.headers || requestDescriptor.headers, key);
          var nextUrl = nextDescriptor.url
            ? nextDescriptor.url.replace(/{{KEY}}/g, encodeURIComponent(key)).replace(/{{KEYRAW}}/g, key)
            : provider.upstream_url + (nextDescriptor.url_path || req.path);

          var nextFetchOpts = {
            method: nextDescriptor.method,
            headers: nextHeaders,
            signal: AbortSignal.timeout(nextReq.timeout_ms || customTimeout),
          };
          if (nextFetchOpts.method !== 'GET' && nextFetchOpts.method !== 'HEAD') {
            if (nextDescriptor.raw_body_buffer instanceof Buffer) {
              nextFetchOpts.body = nextDescriptor.raw_body_buffer;
            } else if (nextDescriptor.body !== undefined && nextDescriptor.body !== null) {
              nextFetchOpts.body = typeof nextDescriptor.body === 'string' ? nextDescriptor.body : JSON.stringify(nextDescriptor.body);
            }
          }
          if (picked.proxyUrl) nextFetchOpts.dispatcher = getProxyAgent(picked.proxyUrl);

          try {
            upstream = await undiciFetch(nextUrl, nextFetchOpts);
          } catch (err) {
            skipped.add(index);
            lastError = 'chain-poll fetch failed: ' + err.message;
            break;
          }

          if (retryCodes.indexOf(upstream.status) !== -1) {
            skipped.add(index);
            lastError = 'Key #' + (index + 1) + ' returned ' + upstream.status + ' during chain-poll';
            break;
          }

          // Re-run response phase on chained upstream
          result = await universalBufferedDownstream(req, res, session, upstream, prefix, ip, strippedModel, modelRaw, true);

          if (result && result.__streamed_downstream_already) {
            // Streaming case handled the response directly; we are done.
            break;
          }
        }

        // Loop ended — flush the final result to res.
        if (result && !result.__errored && !result.__timedOut && !res.headersSent) {
          if (result.passthrough) {
            flushPassthrough(res, upstream, result.bodyBuffer, result);
          } else {
            res.status(result.status || 200);
            if (result.headers && typeof result.headers === 'object') {
              for (var hf in result.headers) res.setHeader(hf, result.headers[hf]);
            }
            if (!res.get('content-type')) res.setHeader('content-type', 'application/json');
            if (result.body !== undefined && result.body !== null) {
              if (typeof result.body === 'string') res.send(result.body);
              else if (result.body instanceof Buffer) res.send(result.body);
              else res.json(result.body);
            } else {
              res.end();
            }
          }
        }
      }
      recordProxyRequest(prefix, ip, upstream.status >= 400, endpointType);
      return;
    } catch (err) {
      skipped.add(index);
      lastError = err.message;
      console.error('[proxy-universal] upstream error:', err.message);
      continue;
    }
  }

  recordProxyRequest(prefix, ip, true, endpointType);
  res.status(502).json({ error: { message: 'All ' + providerKeys.length + ' key(s) for "' + prefix + '" failed. Last error: ' + lastError, type: 'proxy_error' } });
}

// Buffered (non-streamed) universal downstream.
// If noFlush is true, the function does NOT write the response yet — it returns
// { next_request, passthrough, status, headers, body/bodyText/bodyBuffer } so
// the caller can chain-poll. Once a hop has no next_request, the caller flushes.
// If noFlush is false (default), the function writes the response immediately.
async function universalBufferedDownstream(req, res, session, upstream, prefix, ip, strippedModel, modelRaw, noFlush) {
  var bodyBuffer = await upstream.arrayBuffer();
  bodyBuffer = Buffer.from(bodyBuffer);

  var respResult;
  try {
    respResult = await session.dispatchResponse({
      status: upstream.status,
      headers: upstream.headers,
      bodyBuffer: bodyBuffer,
    });
  } catch (err) {
    res.setHeader('x-sandbox-error', 'response phase threw: ' + err.message);
    if (noFlush) {
      return { __errored: true, bodyBuffer: bodyBuffer };
    }
    flushPassthrough(res, upstream, bodyBuffer);
    return;
  }

  if (!respResult || respResult.__timedOut) {
    if (noFlush) return { __timedOut: true, bodyBuffer: bodyBuffer };
    res.setHeader('x-sandbox-error', 'response phase timed out');
    flushPassthrough(res, upstream, bodyBuffer);
    return;
  }

  if (respResult.passthrough) {
    if (noFlush) {
      return { passthrough: true, status: respResult.status, headers: respResult.headers, bodyBuffer: bodyBuffer, next_request: respResult.next_request || null };
    }
    flushPassthrough(res, upstream, bodyBuffer, respResult);
    return;
  }

  // Sandbox shaped it. If chain (next_request), capture without writing.
  if (noFlush && respResult.next_request) {
    return { passthrough: false, status: respResult.status, headers: respResult.headers, body: respResult.body, next_request: respResult.next_request };
  }

  if (noFlush) {
    return { passthrough: false, status: respResult.status || 200, headers: respResult.headers || {}, body: respResult.body, next_request: null };
  }

  res.status(respResult.status || 200);
  if (respResult.headers && typeof respResult.headers === 'object') {
    for (var h in respResult.headers) res.setHeader(h, respResult.headers[h]);
  }
  if (!res.get('content-type')) res.setHeader('content-type', 'application/json');
  if (respResult.body !== undefined && respResult.body !== null) {
    if (typeof respResult.body === 'string') res.send(respResult.body);
    else if (respResult.body instanceof Buffer) res.send(respResult.body);
    else res.json(respResult.body);
  } else {
    res.end();
  }
}

function flushPassthrough(res, upstream, bodyBuffer, respResult) {
  for (var p of upstream.headers.entries()) {
    var l = p[0].toLowerCase();
    if (['transfer-encoding', 'connection', 'keep-alive', 'content-encoding'].indexOf(l) !== -1) continue;
    res.setHeader(p[0], p[1]);
  }
  if (respResult && respResult.headers && typeof respResult.headers === 'object') {
    for (var h2 in respResult.headers) res.setHeader(h2, respResult.headers[h2]);
  }
  res.status((respResult && respResult.status) || upstream.status);
  res.send(Buffer.from(bodyBuffer));
}

// Streamed universal downstream
async function universalStreamDownstream(req, res, session, upstream, prefix, ip, strippedModel, modelRaw,
  upstreamStreamFormat, downstreamStreamFormat, clientWantsStream) {
  // Downstream headers
  res.status(upstream.status);
  var downContentType = mapDownstreamContentType(downstreamStreamFormat);
  res.setHeader('content-type', downContentType);
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');

  var reader = upstream.body.getReader();
  var decoder = new TextDecoder();
  var streamBuffer = '';
  var chunkIndex = 0;

  // Track whether the sandbox actually has a stream_chunk phase. If it doesn't,
  // we use default framing translation: re-emit the upstream frame verbatim in
  // the downstream format. This means sandboxes that only define 'request' still
  // get usable streaming — no more silent drops.
  var hasStreamChunkPhase = session.hasPhase ? session.hasPhase('stream_chunk') : true;

  function defaultDownstreamFrame(rawData, ev) {
    // Re-frame `rawData` (a parsed upstream frame's data string) into the downstream
    // streaming format.
    var fmt = (downstreamStreamFormat || 'sse').toLowerCase();
    if (fmt === 'sse' || fmt === 'openai_chat_sse') {
      return 'event: ' + (ev || '') + '\n' + 'data: ' + rawData + '\n\n';
    }
    if (fmt === 'ndjson' || fmt === 'json_lines') {
      // For NDJSON: only emit if rawData looks like a complete JSON object
      return rawData + '\n';
    }
    if (fmt === 'raw') {
      return rawData;
    }
    return rawData;
  }

  try {
    while (true) {
      var chunk;
      try { chunk = await reader.read(); } catch (e) { break; }
      if (chunk.done) break;
      var rawChunkText = decoder.decode(chunk.value, { stream: true });

      // Split into frames based on upstream_stream_format
      var frames = splitStreamFrames(streamBuffer + rawChunkText, upstreamStreamFormat || 'sse');
      streamBuffer = frames.remainder;

      for (var fi = 0; fi < frames.list.length; fi++) {
        var frame = frames.list[fi];
        var ev = frame.event || '';
        var dataText = frame.data;

        var processed = null;
        if (hasStreamChunkPhase) {
          processed = await session.dispatchStreamChunk({
            chunkText: dataText,
            chunkBuffer: null,
            chunkIndex: chunkIndex++,
            isLast: false,
            upstreamEvent: ev,
          });
        } else {
          chunkIndex++;
          // No stream_chunk phase defined — default passthrough: re-frame the upstream data
          if (downstreamStreamFormat === 'openai_chat_sse' && upstreamStreamFormat !== 'openai_chat_sse') {
            // The user requested OpenAI-chat SSE downstream but provided no translation
            // (there's no stream_chunk defined). We can't synthesize OpenAI chunks
            // from arbitrary upstream frames without a parser. Fall back to "raw" and
            // pass through verbatim so the client at least sees the stream.
            processed = { downstream_chunk: defaultDownstreamFrame(dataText, ev) };
          } else {
            processed = { downstream_chunk: defaultDownstreamFrame(dataText, ev) };
          }
        }

        if (!processed || processed.__timedOut) continue;
        if (processed.done) {
          await session.dispatchStreamEnd();
          // Ensure downstream closes cleanly per downstream format
          if (downstreamStreamFormat === 'openai_chat_sse' || downstreamStreamFormat === 'sse') {
            res.write('data: [DONE]\n\n');
          }
          return;
        }
        if (processed.downstream_chunk !== undefined && processed.downstream_chunk !== null) {
          var dc = processed.downstream_chunk;
          if (typeof dc === 'string') res.write(dc);
          else if (dc instanceof Buffer) res.write(dc);
          else res.write(JSON.stringify(dc));
        }
      }
    }

    // Stream ended naturally; notify sandbox via stream_end
    await session.dispatchStreamEnd();
    if (downstreamStreamFormat === 'openai_chat_sse' || downstreamStreamFormat === 'sse') {
      res.write('data: [DONE]\n\n');
    }
  } catch (err) {
    console.error('[proxy-universal] stream error:', err.message);
    try { res.write('\n[data: stream-error: ' + err.message + ']\n'); } catch (e) {}
  } finally {
    try { res.end(); } catch (e) {}
  }
}

// Frame splitter for common upstream stream formats.
// Returns { list: [{event, data}], remainder: string }
function splitStreamFrames(buffer, format) {
  format = (format || 'sse').toLowerCase();
  var list = [];

  if (format === 'sse') {
    // SSE: blank-line-delimited events. Each event may contain "event:" and one or more "data:" lines.
    var parts = buffer.split('\n\n');
    var remainder = parts.pop() || '';
    for (var i = 0; i < parts.length; i++) {
      var ev = { event: '', data: '' };
      var lines = parts[i].split('\n');
      var dataLines = [];
      for (var j = 0; j < lines.length; j++) {
        var line = lines[j];
        if (line.indexOf('event: ') === 0) ev.event = line.slice(7).trim();
        else if (line.indexOf('data: ') === 0) dataLines.push(line.slice(6));
        else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5));
      }
      ev.data = dataLines.join('\n');
      list.push(ev);
    }
    return { list: list, remainder: remainder };
  } else if (format === 'ndjson' || format === 'json_lines') {
    // One JSON object per line.
    var parts2 = buffer.split('\n');
    var rem2 = parts2.pop() || '';
    for (var k = 0; k < parts2.length; k++) {
      var s = parts2[k].trim();
      if (!s) continue;
      list.push({ event: '', data: s });
    }
    return { list: list, remainder: rem2 };
  } else if (format === 'chunked_json') {
    // Brace-counting split: emit complete top-level JSON objects.
    var depth = 0, start = -1, inString = false, escape = false;
    for (var c = 0; c < buffer.length; c++) {
      var ch = buffer[c];
      if (inString) {
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{' || ch === '[') { if (depth === 0) start = c; depth++; continue; }
      if (ch === '}' || ch === ']') { depth--; if (depth === 0 && start !== -1) { list.push({ event: '', data: buffer.slice(start, c + 1) }); start = -1; } continue; }
    }
    var remainder2 = depth === 0 && start === -1 ? '' : buffer.slice(start === -1 ? buffer.length : start);
    return { list: list, remainder: remainder2 };
  } else {
    // raw: feed whole buffer as one frame
    return { list: [{ event: '', data: buffer }], remainder: '' };
  }
}

function mapDownstreamContentType(downstreamStreamFormat) {
  switch ((downstreamStreamFormat || 'sse').toLowerCase()) {
    case 'ndjson':
    case 'json_lines': return 'application/x-ndjson';
    case 'chunked_json': return 'application/json';
    case 'raw': return 'application/octet-stream';
    case 'openai_chat_sse':
    case 'sse':
    default:
      return 'text/event-stream';
  }
}

// === LEGACY HANDLER =========================================================
// Preserves original behavior: hardcoded chat.completion output, SSE-only streaming,
// retry codes fixed at [401,403,429] + extras, response_format: openai|gemini|anthropic|custom|raw
async function legacyHandler(req, res, provider, prefix, strippedModel, providerKeys, ip, body) {
  var transformed = transformRequest(body, provider, strippedModel, req.path, req.headers, req.method, req, res);

  if (transformed.hijacked) {
    recordProxyRequest(prefix, ip, false);
    return;
  }
  if (transformed.sandbox_error) res.setHeader('x-sandbox-error', transformed.sandbox_error);

  var clientWantsStream = body.stream === true;
  var responseFormat = (transformed.response_format || 'openai').toLowerCase();
  var customStreamContentType = transformed.stream_content_type || null;
  var extraRetryCodes = transformed.retry_codes || [];
  var customTimeout = transformed.timeout || 300000;

  var customParser = null;
  if (responseFormat === 'custom' && transformed.response_parser) {
    customParser = compileCustomParser(transformed.response_parser);
    if (!customParser) responseFormat = 'raw';
  }
  var chunkParser = null;
  if (responseFormat === 'gemini') chunkParser = parseGeminiChunk;
  else if (responseFormat === 'anthropic') chunkParser = parseAnthropicChunk;
  else if (responseFormat === 'custom' && customParser) chunkParser = customParser;

  var skipped = new Set();
  var lastError = null;

  while (true) {
    var picked = getNextKey(prefix, providerKeys, skipped);
    if (!picked) break;

    var key = picked.key;
    var index = picked.index;
    var headers = injectKey(transformed.headers, key);
    var upstreamUrl = transformed.url ? transformed.url.replace(/{{KEY}}/g, key) : provider.upstream_url + transformed.url_path;
    var httpMethod = transformed.method || (req.method === 'GET' ? 'GET' : (req.method || 'POST'));

    try {
      var fetchOpts = { method: httpMethod, headers: headers, signal: AbortSignal.timeout(customTimeout) };
      if (httpMethod !== 'GET' && httpMethod !== 'HEAD') fetchOpts.body = JSON.stringify(transformed.body);
      if (picked.proxyUrl) {
        fetchOpts.dispatcher = getProxyAgent(picked.proxyUrl);
        console.log('[proxy] routing through forward proxy for key index ' + index);
      }

      var upstream = await undiciFetch(upstreamUrl, fetchOpts);

      var retryCodes = [401, 403, 429];
      for (var rc = 0; rc < extraRetryCodes.length; rc++) {
        if (retryCodes.indexOf(Number(extraRetryCodes[rc])) === -1) retryCodes.push(Number(extraRetryCodes[rc]));
      }
      if (retryCodes.indexOf(upstream.status) !== -1) {
        skipped.add(index);
        lastError = 'Key #' + (index + 1) + ' returned ' + upstream.status;
        continue;
      }

      var contentType = upstream.headers.get('content-type') || '';
      var isSSE = contentType.indexOf('text/event-stream') !== -1;
      if (!isSSE && customStreamContentType) isSSE = contentType.indexOf(customStreamContentType) !== -1;
      if (!isSSE && contentType.indexOf('application/x-ndjson') !== -1) isSSE = true;

      for (var pair of upstream.headers.entries()) {
        var hk = pair[0], hv = pair[1], lower = hk.toLowerCase();
        if (['transfer-encoding', 'connection', 'keep-alive', 'content-encoding'].indexOf(lower) !== -1) continue;
        res.setHeader(hk, hv);
      }
      res.status(upstream.status);

      if (responseFormat === 'raw') {
        if (isSSE) {
          res.setHeader('content-type', 'text/event-stream');
          var rawReader = upstream.body.getReader();
          var rawDecoder = new TextDecoder();
          try {
            while (true) {
              var rawChunk = await rawReader.read();
              if (rawChunk.done) break;
              res.write(rawDecoder.decode(rawChunk.value, { stream: true }));
            }
          } catch (e) {}
          res.end();
        } else {
          var rawBody = await upstream.text();
          res.send(rawBody);
        }
        recordProxyRequest(prefix, ip, upstream.status >= 400);
        return;
      }

      if (clientWantsStream && isSSE) {
        res.setHeader('content-type', 'text/event-stream');
        res.setHeader('cache-control', 'no-cache');
        res.setHeader('connection', 'keep-alive');
        var reader = upstream.body.getReader();
        var decoder = new TextDecoder();
        var streamBuffer = '';
        var streamId = 'chatcmpl-' + Date.now();
        var fullModel = prefix + ':' + strippedModel;
        var sentDone = false;

        try {
          while (true) {
            var chunk = await reader.read();
            if (chunk.done) break;
            var textChunk = decoder.decode(chunk.value, { stream: true });
            if (responseFormat === 'openai') { res.write(textChunk); continue; }

            streamBuffer += textChunk;
            var lines = streamBuffer.split('\n');
            streamBuffer = lines.pop() || '';
            var currentEventType = '';

            for (var li = 0; li < lines.length; li++) {
              var line = lines[li].trim();
              if (line.indexOf('event: ') === 0) { currentEventType = line.slice(7).trim(); continue; }
              if (line.indexOf('data: ') !== 0) continue;
              var dataStr = line.slice(6).trim();
              if (dataStr === '[DONE]') { res.write('data: [DONE]\n\n'); sentDone = true; continue; }

              var extractedText = chunkParser ? chunkParser(dataStr, currentEventType) : null;
              if (extractedText) {
                var openaiChunk = { id: streamId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: fullModel, choices: [{ index: 0, delta: { content: extractedText }, finish_reason: null }] };
                res.write('data: ' + JSON.stringify(openaiChunk) + '\n\n');
              }
            }
          }
          if (responseFormat !== 'openai' && !sentDone) res.write('data: [DONE]\n\n');
        } catch (e) {} finally { res.end(); }
        recordProxyRequest(prefix, ip, upstream.status >= 400);
        return;
      }

      if (!clientWantsStream && isSSE) {
        var reader2 = upstream.body.getReader();
        var decoder2 = new TextDecoder();
        var fullContent = '', rModel = strippedModel, finishReason = 'stop', responseId = '', currentEventType2 = '';
        try {
          var buffer2 = '';
          while (true) {
            var chunk2 = await reader2.read();
            if (chunk2.done) break;
            buffer2 += decoder2.decode(chunk2.value, { stream: true });
            var lines2 = buffer2.split('\n');
            buffer2 = lines2.pop() || '';
            for (var li2 = 0; li2 < lines2.length; li2++) {
              var line2 = lines2[li2].trim();
              if (line2.indexOf('event: ') === 0) { currentEventType2 = line2.slice(7).trim(); continue; }
              if (line2.indexOf('data: ') !== 0) continue;
              var data2 = line2.slice(6).trim();
              if (data2 === '[DONE]') continue;
              if (chunkParser) {
                var extracted = chunkParser(data2, currentEventType2);
                if (extracted) fullContent += extracted;
              } else {
                try {
                  var parsed = JSON.parse(data2);
                  responseId = parsed.id || responseId; rModel = parsed.model || rModel;
                  if (parsed.choices && parsed.choices[0] && parsed.choices[0].delta) fullContent += parsed.choices[0].delta.content || '';
                  if (parsed.choices && parsed.choices[0] && parsed.choices[0].finish_reason) finishReason = parsed.choices[0].finish_reason;
                } catch (pe) {}
              }
            }
          }
        } catch (bufErr) {}
        res.setHeader('content-type', 'application/json');
        res.json({ id: responseId || 'chatcmpl-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: prefix + ':' + rModel, choices: [{ index: 0, message: { role: 'assistant', content: fullContent }, finish_reason: finishReason }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
        recordProxyRequest(prefix, ip, upstream.status >= 400);
        return;
      }

      var responseBody = await upstream.text();
      if (responseFormat === 'gemini') {
        var gText = parseGeminiFull(responseBody);
        if (gText !== null) {
          res.setHeader('content-type', 'application/json');
          res.json({ id: 'chatcmpl-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: prefix + ':' + strippedModel, choices: [{ index: 0, message: { role: 'assistant', content: gText }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
          recordProxyRequest(prefix, ip, upstream.status >= 400);
          return;
        }
      }
      if (responseFormat === 'anthropic') {
        var aText = parseAnthropicFull(responseBody);
        if (aText !== null) {
          res.setHeader('content-type', 'application/json');
          try {
            var aResp = JSON.parse(responseBody);
            res.json({ id: aResp.id || 'chatcmpl-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: prefix + ':' + strippedModel, choices: [{ index: 0, message: { role: 'assistant', content: aText }, finish_reason: 'stop' }], usage: { prompt_tokens: (aResp.usage && aResp.usage.input_tokens) || 0, completion_tokens: (aResp.usage && aResp.usage.output_tokens) || 0, total_tokens: ((aResp.usage && aResp.usage.input_tokens) || 0) + ((aResp.usage && aResp.usage.output_tokens) || 0) } });
          } catch (e) {
            res.json({ id: 'chatcmpl-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: prefix + ':' + strippedModel, choices: [{ index: 0, message: { role: 'assistant', content: aText }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
          }
          recordProxyRequest(prefix, ip, upstream.status >= 400);
          return;
        }
      }
      if (responseFormat === 'custom' && customParser) {
        var customText = customParser(responseBody, 'full');
        if (customText) {
          res.setHeader('content-type', 'application/json');
          res.json({ id: 'chatcmpl-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: prefix + ':' + strippedModel, choices: [{ index: 0, message: { role: 'assistant', content: customText }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
          recordProxyRequest(prefix, ip, upstream.status >= 400);
          return;
        }
      }
      res.send(responseBody);
      recordProxyRequest(prefix, ip, upstream.status >= 400);
      return;
    } catch (err) {
      skipped.add(index);
      lastError = err.message;
      continue;
    }
  }

  recordProxyRequest(prefix, ip, true);
  res.status(502).json({ error: { message: 'All ' + providerKeys.length + ' key(s) for "' + prefix + '" failed. Last error: ' + lastError, type: 'proxy_error' } });
}
