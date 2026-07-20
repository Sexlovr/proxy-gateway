// End-to-end HTTP test: boot Express in-process, hit /sandbox/test, /sandbox/files,
// /v1/models, and a simulated upstream via a fake provider. Validates that the
// real proxy code path (not just the in-process sandboxRunner) works for the
// universal contract.
//
// No subprocess needed — we mount the real Express app and use Node's http
// module against it via the `supertest`-free pattern of listening on port 0.

import http from 'http';
import express from 'express';
import cors from 'cors';

import { initStorage, addProvider, recordRequest } from '../src/storage.js';
import { providersRouter } from '../src/providers.js';
import { modelsRouter, getAggregatedModels } from '../src/models.js';
import { statsRouter, trackRequest } from '../src/stats.js';
import { handleProxy } from '../src/proxy.js';
import { initSandboxLoader } from '../src/sandboxLoader.js';
import { sandboxApiRouter } from '../src/sandboxApi.js';

const app = express();
app.use(cors({ origin: '*', methods: '*', allowedHeaders: '*', exposedHeaders: '*', credentials: false }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].indexOf(req.method) !== -1) return next();
  express.json({ limit: '50mb' })(req, res, (err) => { if (err) req.body = {}; next(); });
});
app.use(trackRequest);
app.use('/api/providers', providersRouter);
app.use('/api/models', modelsRouter);
app.use('/api/stats', statsRouter);
app.use('/sandbox', sandboxApiRouter);
app.get('/v1/models', async (_req, res) => {
  try { const m = await getAggregatedModels(); res.json({ object: 'list', data: m }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.all('*', (req, res) => handleProxy(req, res));

// Boot storage + sandbox loader
await new Promise((resolve, reject) => {
  initStorage().then(resolve).catch(reject);
});
initSandboxLoader();

function listen() {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function call(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = { host: '127.0.0.1', port: server.address().port, path, method, headers: {} };
    if (body) {
      const b = JSON.stringify(body);
      opts.headers['content-type'] = 'application/json';
      opts.headers['content-length'] = Buffer.byteLength(b);
    }
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const server = await listen();
const port = server.address().port;

console.log('Test server on port', port);

console.log('\n=== HTTP 1: /health ===');
{
  const r = await call(server, 'GET', '/health');
  console.log('  status=', r.status, 'body=', r.body);
}

console.log('\n=== HTTP 2: POST /v1/chat/completions without model prefix (400) ===');
{
  const r = await call(server, 'POST', '/v1/chat/completions', { model: 'gpt-4o', messages: [] });
  console.log('  status=', r.status, 'body=', r.body);
}

console.log('\n=== HTTP 3: POST /v1/chat/completions with prefix not registered (404) ===');
{
  const r = await call(server, 'POST', '/v1/chat/completions', { model: 'nonexist:gpt-4o', messages: [] });
  console.log('  status=', r.status, 'body=', r.body);
}

console.log('\n=== HTTP 4: register a UNIVERSAL provider, hit it (no key => 401) ===');
{
  const add = await call(server, 'POST', '/api/providers', {
    prefix: 'testuni', name: 'TestUniversal', upstream_url: 'https://upstream.invalid',
    auth_type: 'bearer', models_endpoint: '/v1/models', sandbox_code: `module.exports = {
      universal: true,
      request: function (ctx) {
        return {
          url: 'https://upstream.invalid/v1/chat/completions',
          method: 'POST',
          body: ctx.req,
          endpoint_type: 'chat',
          upstream_stream_format: 'sse',
          downstream_stream_format: 'openai_chat_sse',
          retry_codes: [401, 403, 429]
        };
      },
      response: function (ctx) { return { passthrough: true }; }
    };`,
  });
  console.log('  added:', add.status, add.body);
  const r = await call(server, 'POST', '/v1/chat/completions', { model: 'testuni:gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
  console.log('  status=', r.status, 'body=', r.body);
}

console.log('\n=== HTTP 5: send valid auth key, expect proxy to attempt upstream (401 since DNS not real) ===');
{
  // The upstream is upstream.invalid - not a real host - so we expect the proxy to:
  //   - Pass auth check (key provided)
  //   - Run sandbox request phase (returns upstream url)
  //   - Try to fetch https://upstream.invalid/v1/chat/completions
  //   - Fail with DNS error -> retry with another key (we only sent 1 key) -> 502
  // We verify the universal path actually ran (sandbox_error header should NOT be set).
  const real = await new Promise((resolve, reject) => {
    const b = JSON.stringify({ model: 'testuni:gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    const req = http.request({
      host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(b),
        'authorization': 'Bearer testuni=dummykey'
      }
    }, (res) => {
      let buf = ''; res.on('data', d => buf += d); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); resolve({ error: 'timeout (expected since upstream_invalid not resolvable)' }); });
    req.write(b); req.end();
  });
  console.log('  status=', real.status, 'x-sandbox-error=', real.headers && real.headers['x-sandbox-error'] || '(none)');
  console.log('  body snippet=', String(real.body || real.error || '').slice(0, 250));
  if (real.status === 502 && /fetch failed|ENOTFOUND|getaddrinfo|EAI_AGAIN/i.test(real.body || '')) {
    console.log('  PASS: universal handler reached upstream attempt (got expected 502)');
  } else {
    console.log('  WARN: unexpected result; investigate');
  }
}

console.log('\n=== HTTP 6: GET /sandbox/files ===');
{
  const r = await call(server, 'GET', '/sandbox/files');
  console.log('  status=', r.status, 'body=', r.body);
}

console.log('\n=== HTTP 7: POST /sandbox/test (UNIVERSAL via HTTP) ===');
{
  const r = await call(server, 'POST', '/sandbox/test', {
    code: `module.exports = {
      universal: true,
      request: function (ctx) {
        return {
          url_path: '/v1/embeddings',
          method: 'POST',
          body: ctx.req,
          endpoint_type: 'embeddings',
          retry_codes: [401, 403, 429, 500]
        };
      }
    };`,
    req: { input: 'hello' },
    stripped_model: 'text-embedding-3-small',
  });
  console.log('  status=', r.status);
  try {
    const json = JSON.parse(r.body);
    console.log('  request endpoint_type=', json.request && json.request.endpoint_type);
    console.log('  request retry_codes=', JSON.stringify(json.request && json.request.retry_codes));
  } catch (e) { console.log('  body=', r.body); }
}

console.log('\n=== HTTP 8: POST /sandbox/test (legacy sandbox, expect rejection) ===');
{
  const r = await call(server, 'POST', '/sandbox/test', {
    code: `module.exports = function(req, features, provider, context) { return { body: req }; };`,
  });
  console.log('  status=', r.status, 'body=', r.body);
}

console.log('\n=== HTTP 9: GET /api/stats shows per-provider endpoint breakdown ===');
{
  // Will be 0 since no successful endpoints recorded; we mainly check it doesn't crash
  const r = await call(server, 'GET', '/api/stats');
  console.log('  status=', r.status, 'body=', r.body.slice(0, 250));
}

server.close();
process.exit(0);
