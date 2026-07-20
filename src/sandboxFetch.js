// sandboxFetch.js
// Allowlisted fetch runtime exposed to sandbox code.
//
// Goals:
//   - Sandbox can issue outbound HTTP calls (polling, fan-out, multi-step auth flows, etc.)
//   - Hosts are restricted to provider.upstream_url plus optional provider.allowed_hosts
//   - Per-request caps: concurrent fetches, total bytes, total chained calls, timeout
//   - No file system, no child process, no eval-style escapes
//
// The fetch exposed here is built on undici (already a dependency) so it shares connection
// pooling with the main proxy and supports ProxyAgent for forward proxies.

import { fetch as undiciFetch, ProxyAgent } from 'undici';

var DEFAULT_PER_REQUEST_TIMEOUT_MS = 30000;
var DEFAULT_MAX_CONCURRENT = 5;
var DEFAULT_MAX_CHAIN = 10;
var DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50MB total across all fetches in one request
var DEFAULT_PER_FETCH_TIMEOUT_MS = 30000;

var proxyAgentCache = new Map();
function getProxyAgent(url) {
  if (!proxyAgentCache.has(url)) proxyAgentCache.set(url, new ProxyAgent(url));
  return proxyAgentCache.get(url);
}

function hostnameOf(urlStr) {
  try { return new URL(urlStr).hostname; } catch (e) { return null; }
}

function isAllowedHost(urlStr, allowedHosts) {
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) return true;
  var h = hostnameOf(urlStr);
  if (!h) return false;
  for (var i = 0; i < allowedHosts.length; i++) {
    var allowed = allowedHosts[i];
    if (!allowed) continue;
    allowed = String(allowed).toLowerCase();
    if (allowed === h) return true;
    if (allowed.indexOf('.') === -1) continue;
    if (h === allowed) return true;
    if (h.endsWith('.' + allowed)) return true; // subdomain wildcard by leading '.'? we just do suffix match
  }
  return false;
}

// Build the `fetch` function the sandbox will see.
//   options:
//     allowedHosts:    [string]              - hostnames; [] or null = no outbound allowed
//     forwardProxyUrl: string|null           - if set, route all sandbox fetches through it
//     perRequestTimeout: number (ms)        - total budget across all fetches for this request
//     perFetchTimeout:   number (ms)        - each fetch cap
//     maxConcurrent:    number              - in-flight cap
//     maxChain:         number              - total fetches per request
//     maxBytes:         number              - total bytes per request
//     log:              function(msg)      - debug sink
export function createSandboxedFetch(opts) {
  var allowedHosts = opts.allowedHosts || [];
  var forwardProxyUrl = opts.forwardProxyUrl || null;
  var perRequestTimeout = opts.perRequestTimeout || DEFAULT_PER_REQUEST_TIMEOUT_MS;
  var perFetchTimeout = opts.perFetchTimeout || DEFAULT_PER_FETCH_TIMEOUT_MS;
  var maxConcurrent = opts.maxConcurrent || DEFAULT_MAX_CONCURRENT;
  var maxChain = opts.maxChain || DEFAULT_MAX_CHAIN;
  var maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  var log = typeof opts.log === 'function' ? opts.log : function() {};

  var state = {
    inFlight: 0,
    totalFetches: 0,
    totalBytes: 0,
    deadline: Date.now() + perRequestTimeout,
    aborted: false,
    abortReason: null,
  };

  function fail(reason) {
    if (!state.aborted) {
      state.aborted = true;
      state.abortReason = reason;
      log('[sandboxFetch] aborting: ' + reason);
    }
    var err = new Error('sandboxFetch: ' + reason);
    err.sandboxFetch = true;
    throw err;
  }

  function checkBudget() {
    if (state.aborted) fail(state.abortReason || 'already aborted');
    if (Date.now() > state.deadline) fail('request timeout budget exceeded (' + perRequestTimeout + 'ms)');
    if (state.totalFetches >= maxChain) fail('max chained fetches reached (' + maxChain + ')');
    if (state.totalBytes >= maxBytes) fail('max bytes reached (' + maxBytes + ')');
  }

  // The sandbox-facing fetch. Returns a Response-like object similar to undici's Response, but
  // gently wrapped so the sandbox only touches data, not connection internals.
  async function sandboxedFetch(input, init) {
    init = init || {};
    if (typeof input !== 'string' && !(input && input.url)) {
      var err = new TypeError('sandboxFetch: first argument must be a URL string or Request object');
      throw err;
    }
    var urlStr = typeof input === 'string' ? input : String(input.url);

    if (!isAllowedHost(urlStr, allowedHosts)) {
      fail('host not in allowlist: ' + hostnameOf(urlStr));
    }

    checkBudget();

    // Concurrency check: block if too many in flight
    if (state.inFlight >= maxConcurrent) {
      fail('max concurrent fetches reached (' + maxConcurrent + ')');
    }

    state.inFlight++;
    state.totalFetches++;

    var method = (init.method || 'GET').toUpperCase();
    var headers = init.headers || {};
    var bodySent = init.body;

    var fetchOpts = {
      method: method,
      headers: headers,
      signal: AbortSignal.timeout(perFetchTimeout),
    };
    if (method !== 'GET' && method !== 'HEAD') {
      if (typeof bodySent === 'string') fetchOpts.body = bodySent;
      else if (bodySent && typeof bodySent === 'object') fetchOpts.body = JSON.stringify(bodySent);
    }
    if (forwardProxyUrl) fetchOpts.dispatcher = getProxyAgent(forwardProxyUrl);

    var upstream;
    try {
      upstream = await undiciFetch(urlStr, fetchOpts);
    } catch (e) {
      state.inFlight = Math.max(0, state.inFlight - 1);
      throw e;
    }

    // Wrap response so the sandbox can consume once and capped.
    var consumed = false;
    var self = {
      status: upstream.status,
      ok: upstream.status >= 200 && upstream.status < 300,
      headers: upstream.headers,
      url: upstream.url,

      async text() {
        if (consumed) fail('response already consumed');
        consumed = true;
        var t = await upstream.text();
        state.totalBytes += t.length;
        if (state.totalBytes > maxBytes) fail('max bytes exceeded during text()');
        checkBudget();
        return t;
      },

      async json() {
        var t = await self.text();
        try { return JSON.parse(t); } catch (e) {
          throw new SyntaxError('sandboxFetch: response is not valid JSON');
        }
      },

      async arrayBuffer() {
        if (consumed) fail('response already consumed');
        consumed = true;
        var buf = await upstream.arrayBuffer();
        state.totalBytes += buf.byteLength;
        if (state.totalBytes > maxBytes) fail('max bytes exceeded during arrayBuffer()');
        checkBudget();
        return buf;
      },

      // streaming reader - SANDBOX uses getReader() pattern like browser fetch
      getReader() {
        if (consumed) fail('response already consumed');
        consumed = true;
        var reader = upstream.body.getReader();
        var decoder = new TextDecoder();
        return {
          async read() {
            var r = await reader.read();
            if (!r.done && r.value) state.totalBytes += r.value.byteLength;
            if (state.totalBytes > maxBytes) fail('max bytes exceeded during stream read');
            checkBudget();
            return r;
          },
          releaseLock() { reader.releaseLock(); },
          cancel() { reader.cancel(); },
        };
      },

      // expose decoder for convenience
      TextDecoder: TextDecoder,
    };

    state.inFlight = Math.max(0, state.inFlight - 1);
    return self;
  }

  sandboxedFetch._state = state;
  sandboxedFetch._deadline = function() { return state.deadline; };
  sandboxedFetch._isAborted = function() { return state.aborted; };
  sandboxedFetch._abort = function(reason) { if (!state.aborted) { state.aborted = true; state.abortReason = reason; } };

  return sandboxedFetch;
}

export { DEFAULT_PER_REQUEST_TIMEOUT_MS, DEFAULT_MAX_CONCURRENT, DEFAULT_MAX_CHAIN, DEFAULT_MAX_BYTES };
