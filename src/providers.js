import { Router } from 'express';
import {
  getAllProviders,
  getVisibleProviders,
  getCloakedProvidersList,
  getProvider,
  addProvider,
  updateProvider,
  deleteProvider,
  cloakProvider,
  uncloakProvider,
  getHistory,
} from './storage.js';
import { verifyPassword, verifyProviderAccess } from './auth.js';
import { invalidate } from './sandbox.js';

export var providersRouter = Router();

providersRouter.get('/', function(_req, res) {
  res.json(getVisibleProviders());
});

providersRouter.get('/cloaked', function(_req, res) {
  res.json(getCloakedProvidersList());
});

providersRouter.post('/cloaked/:prefix/reveal', function(req, res) {
  var prefix = req.params.prefix.toLowerCase();
  var p = getProvider(prefix);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (!p.cloaked) return res.json(p);

  var password = (req.body && req.body.password) || '';
  if (!verifyProviderAccess(password, p.cloak_password)) {
    return res.status(403).json({ error: 'Wrong password.' });
  }
  res.json(p);
});

providersRouter.get('/:prefix', function(req, res) {
  var p = getProvider(req.params.prefix.toLowerCase());
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.cloaked) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

providersRouter.get('/:prefix/history', function(req, res) {
  var prefix = req.params.prefix.toLowerCase();
  var p = getProvider(prefix);
  if (p && p.cloaked) return res.json([]);
  res.json(getHistory(prefix));
});

providersRouter.post('/', async function(req, res) {
  var body = req.body || {};
  var prefix = body.prefix;
  var upstream_url = body.upstream_url;

  if (!prefix || !upstream_url) {
    return res.status(400).json({ error: 'prefix and upstream_url are required.' });
  }

  var parsedSandbox = parseJsonField(body.sandbox);
  var parsedThinkConfig = parseJsonField(body.think_config);
  var parsedSearchConfig = parseJsonField(body.search_config);

  if (parsedSandbox === false || parsedThinkConfig === false || parsedSearchConfig === false) {
    return res.status(400).json({ error: 'Invalid JSON in one of the config fields.' });
  }

  var result = await addProvider({
    prefix: prefix.toLowerCase().trim(),
    name: body.name || prefix,
    upstream_url: upstream_url.replace(/\/+$/, ''),
    auth_type: body.auth_type || 'bearer',
    auth_header: body.auth_header || 'authorization',
    optional_key: body.optional_key || '',
    models_endpoint: body.models_endpoint || '/v1/models',
    sandbox: parsedSandbox,
    sandbox_code: body.sandbox_code || null,
    sandbox_file: body.sandbox_file || null,
    allowed_hosts: Array.isArray(body.allowed_hosts) ? body.allowed_hosts : null,
    think_config: parsedThinkConfig,
    search_config: parsedSearchConfig,
    cloaked: body.cloaked || false,
    cloak_name: body.cloak_name || '',
    cloak_password: body.cloak_password || '',
  });

  if (!result.ok) return res.status(409).json({ error: result.reason });
  invalidate(prefix.toLowerCase().trim());
  res.status(201).json({ message: 'Provider "' + prefix + '" created.' });
});

providersRouter.put('/:prefix', async function(req, res) {
  var prefix = req.params.prefix.toLowerCase();
  var updates = req.body || {};

  var jsonFields = ['sandbox', 'think_config', 'search_config'];
  for (var i = 0; i < jsonFields.length; i++) {
    var field = jsonFields[i];
    if (updates[field] && typeof updates[field] === 'string') {
      try {
        updates[field] = JSON.parse(updates[field]);
      } catch (e) {
        return res.status(400).json({ error: field + ' JSON is invalid.' });
      }
    }
  }

  if (updates.upstream_url) {
    updates.upstream_url = updates.upstream_url.replace(/\/+$/, '');
  }

  var result = await updateProvider(prefix, updates);
  if (!result.ok) return res.status(404).json({ error: result.reason });
  invalidate(prefix);
  res.json({ message: 'Updated.', changes: result.changes });
});

providersRouter.post('/:prefix/cloak', async function(req, res) {
  var prefix = req.params.prefix.toLowerCase();
  var body = req.body || {};
  if (!body.cloak_password) {
    return res.status(400).json({ error: 'cloak_password is required.' });
  }
  var result = await cloakProvider(prefix, body.cloak_name || '', body.cloak_password);
  if (!result.ok) return res.status(404).json({ error: result.reason });
  res.json({ message: 'Provider cloaked.' });
});

providersRouter.post('/:prefix/uncloak', async function(req, res) {
  var prefix = req.params.prefix.toLowerCase();
  var p = getProvider(prefix);
  if (!p) return res.status(404).json({ error: 'Not found' });

  var password = (req.body && req.body.password) || '';
  if (!verifyProviderAccess(password, p.cloak_password)) {
    return res.status(403).json({ error: 'Wrong password.' });
  }

  var result = await uncloakProvider(prefix);
  if (!result.ok) return res.status(404).json({ error: result.reason });
  res.json({ message: 'Provider uncloaked.' });
});

providersRouter.delete('/:prefix', async function(req, res) {
  var password = (req.body && req.body.password) || '';
  if (!verifyPassword(password)) {
    return res.status(403).json({ error: 'Wrong password.' });
  }
  var result = await deleteProvider(req.params.prefix.toLowerCase());
  if (!result.ok) return res.status(404).json({ error: result.reason });
  res.json({ message: 'Deleted.' });
});

function parseJsonField(val) {
  if (!val) return null;
  if (typeof val === 'object') return val;
  if (typeof val === 'string') {
    var trimmed = val.trim();
    if (!trimmed) return null;
    try { return JSON.parse(trimmed); } catch (e) { return false; }
  }
  return null;
}
