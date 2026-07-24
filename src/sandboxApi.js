// sandboxApi.js - router for sandbox test/listing endpoints (bridge v2).
//
// Routes:
//   POST /test            - exec a sandbox with a mock ctx; return what it
//                          set on res + any throws
//   GET  /files           - list ./sandboxes/*.js (and per-provider sandbox_code state)
//   GET  /file/:name      - raw source of one sandbox file

import { Router } from 'express';
import { getProvider } from './storage.js';
import { loadSandbox, listSandboxFiles, readSandboxFile, invalidate } from './sandbox.js';
import { openStore } from './kv.js';
import { log, proxyAdminApi } from './log.js';

export var sandboxApiRouter = Router();

// Sandbox mock: returns a tee'd fetch that doesn't touch the network,
// captures writes to res, returns structured snapshot of result.
function makeMockCtx(body, sandboxProvider) {
  const writes = [];
  const headers = {};
  let statusCode = 200;
  let ended = false;
  let jsonSent = null;
  let sentFile = null;

  const mockRes = {
    status(c) { statusCode = c; return mockRes; },
    statusMessage: 'OK',
    setHeader(k, v) { headers[k] = v; return mockRes; },
    set(k, v) { return mockRes.setHeader(k, v); },
    getHeader(k) { return headers[k]; },
    get(k) { return headers[k]; },
    write(chunk) { writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; },
    end(chunk) {
      if (chunk) writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      ended = true;
      return mockRes;
    },
    json(o) { jsonSent = o; headers['content-type'] = 'application/json'; ended = true; return mockRes; },
    send(s) {
      if (Buffer.isBuffer(s)) writes.push(s);
      else writes.push(Buffer.from(String(s)));
      ended = true;
      return mockRes;
    },
    sendFile(p) { sentFile = p; ended = true; return mockRes; },
    on() {}, once() {}, emit() {}, removeListener() {},
    writableEnded: false,
    headersSent: false,
    // getters / make writableEnded reflect `ended` (assignable-once)
    get writableEnded() { return ended; },
    get writableFinished() { return ended; },
  };
  Object.defineProperty(mockRes, 'headersSent', { get() { return ended; }, configurable: true });

  let fetchCount = 0;
  const fetchLog = [];
  const mockFetch = async (url, opts = {}) => {
    fetchCount++;
    const entry = { url, method: opts.method || 'GET', headers: opts.headers || {}, hasBody: opts.body !== undefined };
    fetchLog.push(entry);
    // body capture — if records return desired mock body
    let upstreamBody = '{"hello":"world"}';
    let upstreamStatus = 200;
    let upstreamHeaders = new Map([['content-type', 'application/json']]);
    if (body.upstream && typeof body.upstream === 'object') {
      upstreamStatus = body.upstream.status || upstreamStatus;
      upstreamBody = typeof body.upstream.body === 'string' ? body.upstream.body : JSON.stringify(body.upstream.body || {});
      if (body.upstream.headers) {
        upstreamHeaders = new Map();
        for (const k in body.upstream.headers) upstreamHeaders.set(k, body.upstream.headers[k]);
      }
    }
    return {
      status: upstreamStatus,
      headers: {
        get(name) { return upstreamHeaders.get(name.toLowerCase()) || null; },
        forEach(fn) { upstreamHeaders.forEach((v, k) => fn(v, k)); },
        entries() { return upstreamHeaders.entries(); },
      },
      // Body stream we fake with an async iterable
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(upstreamBody, 'utf8');
        },
        getReader() {
          let consumed = false;
          return {
            async read() {
              if (consumed) return { done: true, value: undefined };
              consumed = true;
              return { done: false, value: Buffer.from(upstreamBody, 'utf8') };
            },
            async cancel() { consumed = true; },
          };
        },
        async cancel() {},
      },
      async arrayBuffer() { return new TextEncoder().encode(upstreamBody).buffer; },
      async text() { return upstreamBody; },
      async json() { return JSON.parse(upstreamBody); },
    };
  };

  const mockReq = {
    method: body.method || 'POST',
    path: body.path || '/v1/messages',
    headers: body.headers || { 'content-type': 'application/json' },
    body: body.req || body.body || {},
    ip: '127.0.0.1',
    id: 'test-' + Math.random().toString(36).slice(2),
  };

  const ctx = {
    req: mockReq,
    res: mockRes,
    prefix: body.prefix || (sandboxProvider && sandboxProvider.prefix) || 'test',
    provider: sandboxProvider || { name: 'test', upstream_url: 'https://example.com' },
    stripped: body.stripped || mockReq.path,
    keys: body.keys || (sandboxProvider ? ['TEST-KEY'] : ['TEST-KEY']),
    key: body.key || (Array.isArray(body.keys) ? body.keys[0] : 'TEST-KEY'),
    nextKey(skipIdx = []) {
      if (!body.keys) return { key: 'TEST-KEY', index: 0, proxyUrl: null };
      const skip = new Set(skipIdx || []);
      const next = body.keys.find((_, i) => !skip.has(i));
      if (!next) return null;
      return { key: next, index: body.keys.indexOf(next), proxyUrl: null };
    },
    fetch: mockFetch,
    store: openStore(sandboxProvider && sandboxProvider.prefix || 'test'),
    proxy: proxyAdminApi,
    log: log.child({ prefix: 'sandbox-test' }),
    signal: null,
    // Test-only introspection accessors
    __test: { writes, headers, statusCode, ended, jsonSent, sentFile, fetchLog, fetchCount, mockRes },
  };
  return ctx;
}

sandboxApiRouter.post('/test', async function (req, res) {
  var body = req.body || {};
  var provider = body.provider ? getProvider(body.provider.toLowerCase()) : null;
  try {
    const sandboxObj = await loadSandbox(provider || { sandbox_code: body.code, sandbox_file: body.filename, prefix: 'test' });
    const ctx = makeMockCtx(body, provider);
    const t0 = Date.now();
    await sandboxObj.request(ctx);
    res.json({
      ok: true,
      elapsed_ms: Date.now() - t0,
      fetchCount: ctx.__test.fetchCount,
      fetchLog: ctx.__test.fetchLog,
      statusCode: ctx.__test.statusCode,
      headers: ctx.__test.headers,
      body: Buffer.concat(ctx.__test.writes).toString('utf8'),
      jsonSent: ctx.__test.jsonSent,
      sentFile: ctx.__test.sentFile,
      ended: ctx.__test.ended,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, stack: (err.stack || '').split('\n').slice(0, 5) });
  }
});

sandboxApiRouter.get('/files', function (_req, res) {
  res.json({ dir: 'sandboxes', files: listSandboxFiles() });
});

sandboxApiRouter.get('/file/:name', function (req, res) {
  const source = readSandboxFile(req.params.name);
  if (source === null) return res.status(404).json({ error: 'not found' });
  res.type('text/plain').send(source);
});
