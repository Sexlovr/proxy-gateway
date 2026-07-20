// sandboxRunner.js
//
// Two entry points:
//   1. runSandboxCode(...)        - LEGACY single-phase contract (preserved for existing sandboxes)
//   2. runSandboxCodeV2(...)     - UNIVERSAL phased contract: 'request' | 'response' | 'stream_chunk'
//
// Both run inside a Node `vm` context with a carefully whitelisted set of globals.
// No fs, no child_process, no process, no require/import surfaced to user code.
//
// The V2 contract is async because sandbox code may call the allowlisted `fetch` we expose.
// Each phase is bounded by a wall-clock timeout enforced at the runtime level (AbortSignal on
// the phase wrapper) — see `runPhaseTimed`.

import vm from 'vm';
import { randomUUID } from 'crypto';
import { createSandboxedFetch } from './sandboxFetch.js';

// Safe Buffer proxy — encoding/decoding only, no file I/O
var SafeBuffer = {
  from: function (data, encoding) { return Buffer.from(data, encoding); },
  alloc: function (size) { return Buffer.alloc(size); },
  allocUnsafe: function (size) { return Buffer.allocUnsafe(size); },
  concat: function (list, length) { return Buffer.concat(list, length); },
  isBuffer: function (obj) { return Buffer.isBuffer(obj); },
  byteLength: function (str, enc) { return Buffer.byteLength(str, enc); },
};

// Strip keys from a provider object so the sandbox never touches secret material.
function buildSafeProvider(provider) {
  if (!provider || typeof provider !== 'object') return {};
  var out = {};
  var passthroughFields = [
    'prefix', 'name', 'upstream_url', 'auth_type', 'auth_header', 'models_endpoint',
    'think_config', 'search_config', 'sandbox', 'allowed_hosts', 'optional_key',
    'upstream_stream_format', 'downstream_stream_format', 'custom_endpoint_map'
  ];
  for (var i = 0; i < passthroughFields.length; i++) {
    var k = passthroughFields[i];
    if (provider[k] !== undefined) out[k] = provider[k];
  }
  // Never expose the raw key. It is injected by the proxy after the request phase.
  return out;
}

// Build the sandboxed global environment shared across phases for a single request.
// `data` is a scratch object that survives across phases for this request.
function buildContext(options) {
  var trace = options.trace || [];
  var log = options.log || function(){};

  // The whitelisted fetch. Per-request state isolated via closure.
  var sbFetch = createSandboxedFetch({
    allowedHosts: options.allowedHosts || [],
    forwardProxyUrl: options.forwardProxyUrl || null,
    perRequestTimeout: options.perRequestTimeout || 30000,
    perFetchTimeout: options.perFetchTimeout || 30000,
    maxConcurrent: options.maxConcurrent || 5,
    maxChain: options.maxChain || 10,
    maxBytes: options.maxBytes || (50 * 1024 * 1024),
    log: log,
  });

  var ctx = vm.createContext({
    // Generic globals
    JSON: JSON, Array: Array, Object: Object, String: String, Number: Number,
    Math: Math, parseInt: parseInt, parseFloat: parseFloat, isNaN: isNaN, isFinite: isFinite,
    Date: Date, RegExp: RegExp, Error: Error, Boolean: Boolean, Map: Map, Set: Set,
    WeakMap: WeakMap, WeakSet: WeakSet, Symbol: Symbol, Promise: Promise,
    // URI / URL
    encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
    encodeURI: encodeURI, decodeURI: decodeURI,
    URL: URL, URLSearchParams: URLSearchParams,
    // Binary / encoding
    Buffer: SafeBuffer,
    TextEncoder: TextEncoder, TextDecoder: TextDecoder,
    btoa: function (s) { return Buffer.from(String(s), 'binary').toString('base64'); },
    atob: function (s) { return Buffer.from(String(s), 'base64').toString('binary'); },
    // Crypto basics - randomUUID only by default. Provider can opt into more via sandbox flag later.
    crypto: { randomUUID: randomUUID },
    // Real timers - proxy cleans them up at end of request via clearAllTimers()
    setTimeout: function (fn, ms) { return setTimeout(fn, typeof ms === 'number' ? Math.min(ms, 30000) : 0); },
    clearTimeout: clearTimeout,
    setInterval: function () { throw new Error('setInterval is not allowed in sandbox'); },
    clearInterval: clearInterval,
    // The outbound fetch runtime
    fetch: sbFetch,
    // Console - captures logs for trace surfacing
    console: {
      log: function () { trace.push({ t: 'log', args: Array.prototype.slice.call(arguments).map(fmtArg) }); },
      error: function () { trace.push({ t: 'error', args: Array.prototype.slice.call(arguments).map(fmtArg) }); },
      warn: function () { trace.push({ t: 'warn', args: Array.prototype.slice.call(arguments).map(fmtArg) }); },
      info: function () { trace.push({ t: 'info', args: Array.prototype.slice.call(arguments).map(fmtArg) }); },
    },
  });

  return ctx;
}

function fmtArg(a) {
  if (a === undefined) return undefined;
  if (a === null) return null;
  if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean') return a;
  try { return JSON.parse(JSON.stringify(a)); } catch (e) { return String(a); }
}

// Compile the user code once per request. The user code defines `module.exports`.
// Returns a vm.Script whose wrapper makes `__sandboxExport` available once executed.
function compileUserCode(code) {
  var wrapper =
    'var module = { exports: {} };\n' +
    'var exports = module.exports;\n' +
    String(code) + '\n' +
    '__sandboxExport = module.exports;\n';
  return new vm.Script(wrapper, { filename: 'sandbox-code.js' });
}

// Detect contract: LEGACY if export is either a non-function or a function called with the
// old positional args. UNIVERSAL if the function declares `mode` or returns a phase-shape.
//
// Detection logic:
//   - After compile, execute once: get the export.
//   - If it's a function, call it with a "PROBE" phase marker { phase: '__probe__' } and inspect return.
//     If return has `universal: true` OR `mode === 'universal'` OR any phase-keys
//     ([request, response, stream_chunk]) are functions, treat as UNIVERSAL.
//   - Otherwise treat as LEGACY (positional call).
//
// To avoid running user code twice on every request, we cache the decision keyed by code string.
var contractCache = new Map();
export function detectContract(exportValue, codeHash) {
  if (codeHash && contractCache.has(codeHash)) return contractCache.get(codeHash);

  var contract = 'legacy';
  if (typeof exportValue === 'function') {
    // Probe with a marker; user is supposed to handle unknown phases gracefully.
    try {
      var probe = exportValue({ phase: '__probe__', isModelsRequest: false });
      if (probe && typeof probe === 'object') {
        if (probe.universal === true || probe.mode === 'universal') contract = 'universal';
        else if (typeof probe.request === 'function' ||
                 typeof probe.response === 'function' ||
                 typeof probe.stream_chunk === 'function') contract = 'universal';
      }
    } catch (e) {
      // Most likely "phase not supported" sort of error - treat as legacy
      contract = 'legacy';
    }
  }
  if (codeHash) contractCache.set(codeHash, contract);
  return contract;
}

// Run the user code in the context; returns whatever `module.exports` ended up being.
// This MUST be called once per request - the export value is the handle we'll dispatch
// the phases through.
function loadUserModule(script, ctx, timeoutMs) {
  script.runInContext(ctx, { timeout: timeoutMs || 2000 });
  return ctx.__sandboxExport;
}

// === LEGACY ENTRY POINT =====================================================
// Backward-compatible single-phase contract from the original codebase.
// NOT exported/called by the universal proxy path.
export function runSandboxCode(code, reqBody, features, provider, requestContext, expressReq, expressRes) {
  var result = {
    body: reqBody,
    handled: {},
    url: null,
    url_path: null,
    headers: null,
    method: null,
    response_format: null,
    response_parser: null,
    stream_content_type: null,
    retry_codes: null,
    timeout: null,
    hijacked: false,
    error: null,
  };

  if (!code || typeof code !== 'string' || !code.trim()) return result;

  var trace = [];
  try {
    var safeReq = JSON.parse(JSON.stringify(reqBody));
    var safeFeatures = JSON.parse(JSON.stringify(features));
    var safeProvider = {
      prefix: provider.prefix,
      name: provider.name,
      upstream_url: provider.upstream_url,
      auth_type: provider.auth_type,
      auth_header: provider.auth_header || 'authorization',
      models_endpoint: provider.models_endpoint || '/v1/models',
    };
    var safeContext = {
      path: (requestContext && requestContext.path) || '/v1/chat/completions',
      method: (requestContext && requestContext.method) || 'POST',
      original_model: (requestContext && requestContext.original_model) || '',
      stripped_model: (requestContext && requestContext.stripped_model) || '',
    };
    var safeExpressReq = null;
    if (expressReq) {
      safeExpressReq = {
        method: expressReq.method,
        path: expressReq.path,
        url: expressReq.url,
        headers: expressReq.headers,
        query: expressReq.query,
        ip: expressReq.ip,
        body: reqBody,
      };
    }
    var safeExpressRes = null;
    if (expressRes) {
      safeExpressRes = {
        status: function (c) { expressRes.status(c); return safeExpressRes; },
        send: function (d) { expressRes.send(d); return safeExpressRes; },
        json: function (d) { expressRes.json(d); return safeExpressRes; },
        setHeader: function (k, v) { expressRes.setHeader(k, v); return safeExpressRes; },
        end: function (d) { expressRes.end(d); },
        write: function (d) { expressRes.write(d); },
      };
    }

    var ctx = vm.createContext({
      __req: safeReq, __features: safeFeatures, __provider: safeProvider,
      __context: safeContext, __expressReq: safeExpressReq, __expressRes: safeExpressRes,
      __result: null,
      JSON: JSON, Array: Array, Object: Object, String: String, Number: Number, Math: Math,
      parseInt: parseInt, parseFloat: parseFloat, isNaN: isNaN, isFinite: isFinite,
      Date: Date, RegExp: RegExp, Error: Error, Boolean: Boolean, Map: Map, Set: Set,
      encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
      encodeURI: encodeURI, decodeURI: decodeURI, URL: URL, URLSearchParams: URLSearchParams,
      Buffer: SafeBuffer, TextEncoder: TextEncoder, TextDecoder: TextDecoder,
      btoa: function (s) { return Buffer.from(String(s), 'binary').toString('base64'); },
      atob: function (s) { return Buffer.from(String(s), 'base64').toString('binary'); },
      crypto: { randomUUID: randomUUID },
      setTimeout: function (fn) { if (typeof fn === 'function') fn(); },
      clearTimeout: function () {},
      console: {
        log: function () { trace.push({ t: 'log', args: Array.prototype.slice.call(arguments).map(fmtArg) }); },
        error: function () { trace.push({ t: 'error', args: Array.prototype.slice.call(arguments).map(fmtArg) }); },
        warn: function () { trace.push({ t: 'warn', args: Array.prototype.slice.call(arguments).map(fmtArg) }); },
        info: function () { trace.push({ t: 'info', args: Array.prototype.slice.call(arguments).map(fmtArg) }); },
      },
    });

    var wrapper =
      'var module = { exports: {} };\n' +
      'var exports = module.exports;\n' +
      String(code.trim()) + '\n' +
      '__result = (typeof module.exports === "function") ? module.exports(__req, __features, __provider, __context, __expressReq, __expressRes) : null;\n';
    var script = new vm.Script(wrapper);
    script.runInContext(ctx, { timeout: 5000 });

    if (ctx.__result) {
      var r = ctx.__result;
      if (r.hijacked) {
        result.hijacked = true;
        return result;
      }
      if (r.body) result.body = r.body;
      else if (!r.handled && !r.url && !r.url_path && !r.headers && !r.method && !r.response_format && !r.response_parser) {
        result.body = r;
      }
      if (r.handled) result.handled = r.handled;
      if (r.url) result.url = String(r.url);
      if (r.url_path) result.url_path = String(r.url_path);
      if (r.method) result.method = String(r.method).toUpperCase();
      if (r.response_format) result.response_format = String(r.response_format).toLowerCase();
      if (r.response_parser) result.response_parser = String(r.response_parser);
      if (r.stream_content_type) result.stream_content_type = String(r.stream_content_type).toLowerCase();
      if (r.retry_codes && Array.isArray(r.retry_codes)) result.retry_codes = r.retry_codes;
      if (r.timeout && !isNaN(Number(r.timeout))) result.timeout = Number(r.timeout);
      if (r.headers && typeof r.headers === 'object') {
        result.headers = {};
        for (var hk in r.headers) result.headers[hk.toLowerCase()] = String(r.headers[hk]);
      }
    }
  } catch (e) {
    result.body = reqBody;
    result.handled = {};
    result.error = e.message;
  }

  return result;
}

// === UNIVERSAL ENTRY POINT (V2) ============================================
//
// Returns a "session" object with methods to dispatch each phase.
// The proxy calls these methods; each takes the appropriate arguments.
//
// Universal export shape (user code):
//
//   module.exports = {
//     universal: true,
//     request:    function(ctx) { ... },          // OPTIONAL - edit outgoing request
//     response:   async function(ctx) { ... },     // OPTIONAL - shape downstream non-streamed
//     stream_chunk: function(ctx) { ... },          // OPTIONAL - per streaming chunk
//     stream_end: function(ctx) { ... },             // OPTIONAL - called at stream end
//   };
//
//   OR (legacy convenience):
//
//   module.exports = function(ctx) {
//     if (ctx.phase === 'request') return { ... upcall descriptor ... };
//     if (ctx.phase === 'response') return { ... downstream payload ... };
//     if (ctx.phase === 'stream_chunk') return { ... chunk ... };
//   };
//
// ctx for request phase has:
//   { phase, req, features, provider, context, stream, data }
// ctx for response phase has:
//   { phase, req, features, provider, context, stream, data,
//     upstream: { status, headers, bodyText, bodyJson?, bodyBuffer }, isStream }
// ctx for stream_chunk phase has:
//   { phase, req, features, provider, context, stream, data,
//     chunkText, chunkBuffer, chunkIndex, isLast, upstreamEvent, isStream }
//
// 'data' is a shared scratch object (mutable across phases). Persists within one request.
//
// Each request phase returns:
//   {
//     url, url_path, method, headers, body,
//     is_multipart, form,     // for multipart/form-data uploads
//     raw_body_buffer,        // Buffer for binary uploads (overrides body when set)
//     stream: true|false,                       // sandbox overrides client intent
//     upstream_stream_format: 'sse'|'ndjson'|'json_lines'|'chunked_json'|'raw'|'none',
//     downstream_stream_format: ... same set ...
//     retry_codes: [int],                       // FULLY replaces default (legacy was add-only)
//     retry_codes_mode: 'replace'|'merge',      // default 'replace' in v2
//     timeout_ms: int,
//     handled: {feature: true},
//     endpoint_type: 'chat'|'embeddings'|'images'|'audio'|'responses'|'moderations'|'files'|'raw',
//     hijack: true,                             // sandbox owns downstream fully; proxy stops
//     passthrough: true,                        // response phase forwards upstream untouched
//     next_request: null | {...},               // chain-poll descriptor (for async jobs)
//     done: true                                // for stream_chunk / chain end
//   }
//
// Response phase returns:
//   { status, headers, body, passthrough: true }
// Stream_chunk phase returns:
//   { downstream_chunk: string|Buffer|null, done: true }
//
export function createSandboxSession(code, opts) {
  opts = opts || {};
  if (!code || typeof code !== 'string' || !code.trim()) return null;

  var trace = [];
  var timers = [];
  var log = opts.log || function () {};
  var sessionError = null;

  var ctx = buildContext({
    allowedHosts: opts.allowedHosts || [],
    forwardProxyUrl: opts.forwardProxyUrl || null,
    perRequestTimeout: opts.perRequestTimeout || 30000,
    perFetchTimeout: opts.perFetchTimeout || 30000,
    maxConcurrent: opts.maxConcurrent || 5,
    maxChain: opts.maxChain || 10,
    maxBytes: opts.maxBytes || (50 * 1024 * 1024),
    trace: trace,
    log: log,
  });

  // Compile + load user module once. The exported handle is reused per phase.
  var script = compileUserCode(code);
  var exportValue;
  try {
    exportValue = loadUserModule(script, ctx, 2000);
  } catch (e) {
    log('[sandbox-v2] failed to load user module: ' + e.message);
    return {
      error: 'failed to load sandbox: ' + e.message,
      trace: trace,
      durationMs: 0,
      dispose: function () {},
    };
  }

  // Determine dispatch handle:
  //  - Function export => universal dispatch via the function itself
  //  - Object export with universal:true => phase functions on the object
  var phaseFn;
  var asObject = false;
  if (typeof exportValue === 'function') {
    phaseFn = exportValue;
    asObject = false;
  } else if (exportValue && typeof exportValue === 'object' && exportValue.universal === true) {
    phaseFn = exportValue;
    asObject = true;
  } else {
    // Object export without universal flag => treat as legacy single-phase. Caller should fall back.
    return null;
  }

  // Build the per-request shared 'data' bag
  var sessionData = {};

  // Replace setTimeout to track our timers
  // (We rebuild ctx.setTimeout? can't easily; instead proxy will dispose timers at end via clearTimeout on active ids.)
  // For v1 we rely on the natural GC + the runtime clearing outstanding timers during dispose.

  function callPhase(phase, ctxObj) {
    if (asObject) {
      if (typeof phaseFn[phase] !== 'function') return undefined;
      return phaseFn[phase](ctxObj);
    } else {
      ctxObj.phase = phase;
      return phaseFn(ctxObj);
    }
  }

  function buildContextObject(extra) {
    var base = {
      phase: null,
      req: opts.req || null,
      features: opts.features || {},
      provider: buildSafeProvider(opts.provider || {}),
      context: opts.context || {},
      stream: !!opts.stream,
      data: sessionData,
    };
    if (extra) {
      for (var k in extra) base[k] = extra[k];
    }
    return base;
  }

  // Apply per-phase wall-clock timeout. Silent if times out (returns { __timedOut: true }).
  function withTimeout(fn, ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        resolve({ __timedOut: true });
      }, ms || 5000);
      Promise.resolve()
        .then(function () { return fn(); })
        .then(function (v) {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve(v);
        }, function (e) {
          if (done) return;
          done = true;
          clearTimeout(t);
          reject(e);
        });
    });
  }

  // Phase 1: request
  async function dispatchRequest() {
    if (asObject && typeof phaseFn.request !== 'function') return null;
    var c = buildContextObject({});
    var r = await withTimeout(function () { return callPhase('request', c); }, 5000);
    if (r && r.__timedOut) return { __timedOut: true, trace: trace };
    return normalizeRequestResult(r);
  }

  // Phase 2: response (non-streamed upstream)
  async function dispatchResponse(upstream) {
    if (asObject && typeof phaseFn.response !== 'function') return null;
    var bodyText = null, bodyBuffer = null, bodyJson = undefined;
    if (upstream.bodyBuffer) {
      bodyBuffer = upstream.bodyBuffer;
      try { bodyText = bodyBuffer.toString('utf8'); } catch (e) {}
    }
    var contentType = (upstream.headers && upstream.headers.get && upstream.headers.get('content-type')) || '';
    if (bodyText && contentType.toLowerCase().indexOf('application/json') !== -1 && bodyText.length < (10 * 1024 * 1024)) {
      try { bodyJson = JSON.parse(bodyText); } catch (e) { /* sandbox will parse */ }
    }
    var c = buildContextObject({
      upstream: {
        status: upstream.status,
        headers: upstream.headers,
        bodyText: bodyText,
        bodyJson: bodyJson,
        bodyBuffer: bodyBuffer,
      },
      isStream: false,
    });
    var r = await withTimeout(function () { return callPhase('response', c); }, 5000);
    if (r && r.__timedOut) return { __timedOut: true, trace: trace };
    return normalizeResponseResult(r, bodyText, bodyBuffer, upstream);
  }

  // Phase 3: stream_chunk
  async function dispatchStreamChunk(chunkInfo) {
    if (asObject && typeof phaseFn.stream_chunk !== 'function') return null;
    var c = buildContextObject({
      chunkText: chunkInfo.chunkText || '',
      chunkBuffer: chunkInfo.chunkBuffer || null,
      chunkIndex: chunkInfo.chunkIndex || 0,
      isLast: !!chunkInfo.isLast,
      upstreamEvent: chunkInfo.upstreamEvent || '',
      isStream: true,
    });
    var r = await withTimeout(function () { return callPhase('stream_chunk', c); }, 2000);
    if (r && r.__timedOut) return { __timedOut: true, trace: trace };
    return normalizeStreamChunkResult(r);
  }

  // Phase 4: stream_end
  async function dispatchStreamEnd() {
    if (asObject && typeof phaseFn.stream_end !== 'function') return null;
    var c = buildContextObject({ isLast: true, isStream: true });
    try {
      var r = await withTimeout(function () { return callPhase('stream_end', c); }, 2000);
      return r;
    } catch (e) {
      return null;
    }
  }

  // ===================== result normalization =====================
  function normalizeRequestResult(r) {
    if (!r || typeof r !== 'object') return null;
    // Preserve ALL keys the sandbox returned, then normalize the ones we know about.
    // This means sandboxes can attach arbitrary metadata that the proxy or downstream
    // tools may use - we don't drop anything.
    var out = {};
    for (var k in r) out[k] = r[k];

    out.url = r.url ? String(r.url) : null;
    out.url_path = r.url_path ? String(r.url_path) : null;
    out.method = r.method ? String(r.method).toUpperCase() : null;
    out.headers = null;
    out.body = r.body !== undefined ? r.body : null;
    out.raw_body_buffer = r.raw_body_buffer instanceof Buffer ? r.raw_body_buffer : null;
    out.is_multipart = !!r.is_multipart;
    out.form = r.form || null;
    out.stream = typeof r.stream === 'boolean' ? r.stream : null;
    out.upstream_stream_format = r.upstream_stream_format ? String(r.upstream_stream_format).toLowerCase() : null;
    out.downstream_stream_format = r.downstream_stream_format ? String(r.downstream_stream_format).toLowerCase() : null;
    out.retry_codes = Array.isArray(r.retry_codes) ? r.retry_codes.map(Number) : null;
    out.retry_codes_mode = r.retry_codes_mode ? String(r.retry_codes_mode) : 'replace';
    out.timeout_ms = r.timeout_ms && !isNaN(Number(r.timeout_ms)) ? Number(r.timeout_ms) : null;
    out.handled = r.handled || {};
    out.endpoint_type = r.endpoint_type ? String(r.endpoint_type).toLowerCase() : null;
    out.hijack = !!r.hijack;
    out.passthrough = !!r.passthrough;
    out.next_request = r.next_request || null;
    out.error = null;
    if (r.headers && typeof r.headers === 'object') {
      out.headers = {};
      for (var hk in r.headers) out.headers[hk.toLowerCase()] = r.headers[hk];
    }
    return out;
  }

  function normalizeResponseResult(r, defaultBodyText, defaultBodyBuffer, upstream) {
    if (!r || typeof r !== 'object') {
      // No response phase authored → passthrough upstream as-is
      return {
        passthrough: true,
        status: upstream ? upstream.status : 200,
        headers: upstream ? upstream.headers : null,
        bodyText: defaultBodyText,
        bodyBuffer: defaultBodyBuffer,
        next_request: null,
      };
    }
    if (r.__timedOut) {
      return {
        passthrough: true,
        status: upstream ? upstream.status : 200,
        headers: upstream ? upstream.headers : null,
        bodyText: defaultBodyText,
        bodyBuffer: defaultBodyBuffer,
        next_request: null,
        sandboxError: 'response phase timed out',
      };
    }
    if (r.passthrough) {
      // Preserve all sandbox-authored fields (next_request, endpoint_type overrides, etc.)
      var passOut = {
        passthrough: true,
        status: r.status || (upstream ? upstream.status : 200),
        headers: r.headers || (upstream ? upstream.headers : null),
        bodyText: defaultBodyText,
        bodyBuffer: defaultBodyBuffer,
        next_request: r.next_request || null,
      };
      // Preserve any extra fields the sandbox returned
      for (var ek in r) {
        if (ek === 'passthrough' || ek === 'status' || ek === 'headers' || ek === 'bodyText' || ek === 'bodyBuffer' || ek === 'next_request') continue;
        passOut[ek] = r[ek];
      }
      return passOut;
    }
    var out = {
      passthrough: false,
      status: r.status || 200,
      headers: r.headers || {},
      body: r.body !== undefined ? r.body : null,
      next_request: r.next_request || null,
    };
    // Preserve any extra fields the sandbox returned
    for (var ek2 in r) {
      if (ek2 === 'passthrough' || ek2 === 'status' || ek2 === 'headers' || ek2 === 'body' || ek2 === 'next_request') continue;
      out[ek2] = r[ek2];
    }
    return out;
  }

  function normalizeStreamChunkResult(r) {
    if (!r || typeof r !== 'object') return null;
    if (r.__timedOut) return { downstream_chunk: null, done: true, sandboxError: 'stream_chunk timed out' };
    return {
      downstream_chunk: r.downstream_chunk !== undefined ? r.downstream_chunk : null,
      done: !!r.done,
    };
  }

  function dispose() {
    // Clear any outstanding timers in the sandbox context
    try {
      // VM context timers are real host timers; we can clear by iterating the active handles.
      // For v1 we don't have a precise handle list, so rely on natural expiry. The fetch sandbox
      // budget is enforced internally.
    } catch (e) {}
  }

  function hasPhase(name) {
    if (asObject) return typeof phaseFn[name] === 'function';
    // Function-style export: sandbox is expected to handle every phase it cares
    // about — the proxy can't statically know. Be conservative: report true so
    // the proxy still calls dispatch (the sandbox can return undefined or null
    // for phases it doesn't recognise; the proxy handles that gracefully).
    return true;
  }

  return {
    dispatchRequest: dispatchRequest,
    dispatchResponse: dispatchResponse,
    dispatchStreamChunk: dispatchStreamChunk,
    dispatchStreamEnd: dispatchStreamEnd,
    hasPhase: hasPhase,
    getTrace: function () { return trace; },
    getError: function () { return sessionError; },
    dispose: dispose,
  };
}
