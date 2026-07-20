// sandboxApi.js - Express router for sandbox test/listing endpoints.
//
// Extracted from server.js so the same router can be mounted by tests and the
// main app. Routes:
//   POST /test            - run sandbox request phase simulation
//   POST /test_response   - run sandbox response phase simulation
//   GET  /files           - list loaded sandbox files
//   GET  /file/:name      - return cached source of a sandbox file

import { Router } from 'express';
import { getProvider } from './storage.js';
import { getSandboxCode, listSandboxFiles, getSandboxDir } from './sandboxLoader.js';
import { createSandboxSession } from './sandboxRunner.js';

export var sandboxApiRouter = Router();

function resolveCode(body) {
  var code = body.code || null;
  if (!code && body.filename) {
    var fetched = getSandboxCode(body.filename);
    if (fetched && fetched.error) return { error: fetched.error };
    code = fetched ? fetched.code : null;
  }
  if (!code && body.provider) {
    var p = getProvider(body.provider.toLowerCase());
    if (!p) return { error: 'provider not found' };
    if (p.sandbox_code) code = p.sandbox_code;
    else if (p.sandbox_file) {
      var f2 = getSandboxCode(p.sandbox_file);
      if (f2 && f2.error) return { error: f2.error };
      code = f2 ? f2.code : null;
    }
  }
  return { code: code };
}

sandboxApiRouter.post('/test', async function (req, res) {
  var body = req.body || {};
  var resolved = resolveCode(body);
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  var code = resolved.code;
  if (!code) return res.status(400).json({ error: 'no code supplied (send code, filename, or provider)' });

  var p = body.provider ? (getProvider(body.provider.toLowerCase()) || {}) : { name: 'test' };

  var session = createSandboxSession(code, {
    req: body.req || {},
    features: body.features || {},
    provider: p,
    context: {
      path: body.path || '/v1/chat/completions',
      method: body.method || 'POST',
      original_model: body.original_model || (body.req && body.req.model) || '',
      stripped_model: body.stripped_model || '',
    },
    stream: !!body.stream,
    allowedHosts: body.allowed_hosts || [],
    perRequestTimeout: 5000,
    perFetchTimeout: 5000,
    maxConcurrent: 1,
    maxChain: 1,
    maxBytes: 1 * 1024 * 1024,
    log: function () {},
  });
  if (!session || session.error) return res.status(400).json({ error: session ? session.error : 'sandbox does not declare universal contract' });

  try {
    var reqResult = await session.dispatchRequest();
    var out = { request: reqResult, trace: session.getTrace() };
    session.dispose();
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message, trace: session.getTrace() });
  }
});

sandboxApiRouter.post('/test_response', async function (req, res) {
  var body = req.body || {};
  var resolved = resolveCode(body);
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  var code = resolved.code;
  if (!code) return res.status(400).json({ error: 'no code supplied' });

  var p = body.provider ? (getProvider(body.provider.toLowerCase()) || {}) : { name: 'test' };

  var session = createSandboxSession(code, {
    req: body.req || {},
    provider: p,
    allowedHosts: [],
    perRequestTimeout: 5000,
    maxChain: 1,
    log: function () {},
  });
  if (!session || session.error) return res.status(400).json({ error: session ? session.error : 'sandbox does not declare universal contract' });

  try {
    var upstreamBodyBuffer = Buffer.from(body.upstreamBody || '', 'utf8');
    var fakeHeaders = new Map();
    if (body.upstreamHeaders) {
      for (var k in body.upstreamHeaders) fakeHeaders.set(k, body.upstreamHeaders[k]);
    }
    if (body.upstreamContentType) fakeHeaders.set('content-type', body.upstreamContentType);

    var respResult = await session.dispatchResponse({
      status: body.upstreamStatus || 200,
      headers: fakeHeaders,
      bodyBuffer: upstreamBodyBuffer,
    });
    var out = { response: respResult, trace: session.getTrace() };
    session.dispose();
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message, trace: session.getTrace() });
  }
});

sandboxApiRouter.get('/files', function (_req, res) {
  res.json({ dir: getSandboxDir(), files: listSandboxFiles() });
});

sandboxApiRouter.get('/file/:name', function (req, res) {
  var fetched = getSandboxCode(req.params.name);
  if (!fetched) return res.status(404).json({ error: 'not found' });
  if (fetched.error) return res.status(400).json({ error: fetched.error });
  res.type('text/plain').send(fetched.code);
});
