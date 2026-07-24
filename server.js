import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';

import { initStorage } from './src/storage.js';
import { providersRouter } from './src/providers.js';
import { modelsRouter, getAggregatedModels } from './src/models.js';
import { statsRouter, trackRequest } from './src/stats.js';
import { handleProxy } from './src/bridgeProxy.js';
import { sandboxApiRouter } from './src/sandboxApi.js';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var PORT = process.env.PORT || 7860;
var app = express();

app.use(cors({ origin: '*', methods: '*', allowedHeaders: '*', exposedHeaders: '*', credentials: false }));

app.get('/health', function(_req, res) { res.json({ status: 'ok', uptime: process.uptime() }); });



// --- Static-serving of the public/ SPA (new "Terminal Glass" redesign) ---
// The page is now a real static SPA mounted under /public. Anything that does
// not match an API/v1/sandbox route falls through to index.html (history mode).
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', fallthrough: true }));

app.use(function(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  express.json({ limit: '50mb' })(req, res, function(err) {
    if (err) req.body = {};
    next();
  });
});

app.use(trackRequest);
app.use('/api/providers', providersRouter);
app.use('/api/models', modelsRouter);
app.use('/api/stats', statsRouter);

app.get('/v1/models', async function(_req, res) {
  try {
    var models = await getAggregatedModels();
    res.json({ object: 'list', data: models });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Sandbox testing endpoints ───────────────────────────────────────────────
//   POST /sandbox/test           - run sandbox request phase (no real upstream call)
//   POST /sandbox/test_response  - run sandbox response phase with provided upstream body
//   GET  /sandbox/files          - list loaded ./sandboxes/*.js files
//   GET  /sandbox/file/:name     - return source of one sandbox file
app.use('/sandbox', sandboxApiRouter);

// SPA fallback: any non-API GET returns the index so client-side routing works.
app.get('*', function(req, res, next) {
  if (req.path.startsWith('/api/') || req.path.startsWith('/v1/') || req.path.startsWith('/sandbox/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.all('*', function(req, res, next) {
  if (req.path.startsWith('/sandbox/')) return next();
  return handleProxy(req, res);
});

try {
  await initStorage();
  console.log('[boot] Storage initialized');
} catch (e) {
  console.error('[boot] Storage init error:', e.message);
}

app.listen(PORT, '0.0.0.0', function() {
  console.log('Proxy Gateway (bridge v2) live on :' + PORT);
});
