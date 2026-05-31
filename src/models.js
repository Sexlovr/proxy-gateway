import { Router } from 'express';
import { getAllProviders, getProvider, getCachedModels, setCachedModels, getAllCachedModels } from './storage.js';

export var modelsRouter = Router();

modelsRouter.post('/fetch/:prefix', async function(req, res) {
  var prefix = req.params.prefix.toLowerCase();
  var provider = getProvider(prefix);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });

  var key = (req.body && req.body.key) || provider.optional_key || '';

  try {
    var models = await fetchModelsFromProvider(provider, key);
    setCachedModels(prefix, models);
    res.json({ prefix: prefix, count: models.length, models: models });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

modelsRouter.post('/fetch', async function(req, res) {
  var providers = getAllProviders();
  var keys = (req.body && req.body.keys) || {};
  var results = {};

  for (var prefix in providers) {
    var provider = providers[prefix];
    var key = keys[prefix] || provider.optional_key || '';
    try {
      var models = await fetchModelsFromProvider(provider, key);
      setCachedModels(prefix, models);
      results[prefix] = { count: models.length, models: models };
    } catch (e) {
      results[prefix] = { error: e.message, models: [] };
    }
  }

  res.json(results);
});

modelsRouter.get('/', function(_req, res) {
  var all = getAllCachedModels();
  var providers = getAllProviders();
  var flat = [];
  for (var prefix in all) {
    if (providers[prefix] && providers[prefix].cloaked) continue;
    var data = all[prefix];
    for (var i = 0; i < data.models.length; i++) {
      var m = data.models[i];
      flat.push({ id: prefix + ':' + m.id, object: 'model', owned_by: prefix, original_id: m.id });
    }
  }
  res.json(flat);
});

export async function getAggregatedModels() {
  var all = getAllCachedModels();
  var providers = getAllProviders();
  var data = [];
  for (var prefix in all) {
    if (providers[prefix] && providers[prefix].cloaked) continue;
    var cached = all[prefix];
    for (var i = 0; i < cached.models.length; i++) {
      var m = cached.models[i];
      data.push({
        id: prefix + ':' + m.id,
        object: 'model',
        created: m.created || Math.floor(Date.now() / 1000),
        owned_by: prefix,
      });
    }
  }
  return data;
}

async function fetchModelsFromProvider(provider, key) {
  var baseUrl = provider.upstream_url + (provider.models_endpoint || '/v1/models');
  var allModels = [];
  var url = baseUrl;
  var page = 0;
  var maxPages = 50;

  while (url && page < maxPages) {
    var headers = { 'content-type': 'application/json' };
    var authType = (provider.auth_type || 'bearer').toLowerCase();

    if (key) {
      if (authType === 'bearer') {
        headers['authorization'] = 'Bearer ' + key;
      } else if (authType === 'x-api-key') {
        headers['x-api-key'] = key;
      } else {
        headers[provider.auth_header || 'authorization'] = key;
      }
    }

    var resp = await fetch(url, {
      method: 'GET',
      headers: headers,
      signal: AbortSignal.timeout(60000)
    });

    if (!resp.ok) {
      var text = await resp.text().catch(function() { return ''; });
      throw new Error('Upstream ' + resp.status + ': ' + text.slice(0, 300));
    }

    var json = await resp.json();
    var pageModels = extractModels(json);

    for (var i = 0; i < pageModels.length; i++) {
      allModels.push(pageModels[i]);
    }

    console.log('[models] fetched page ' + page + ' from ' + provider.prefix + ': ' + pageModels.length + ' models (total: ' + allModels.length + ')');

    var nextUrl = null;

    if (json.has_more && json.next_cursor) {
      var separator = baseUrl.indexOf('?') !== -1 ? '&' : '?';
      nextUrl = baseUrl + separator + 'cursor=' + json.next_cursor;
    } else if (json.next_page_token) {
      var separator2 = baseUrl.indexOf('?') !== -1 ? '&' : '?';
      nextUrl = baseUrl + separator2 + 'page_token=' + json.next_page_token;
    } else if (json.pagination && json.pagination.next) {
      nextUrl = json.pagination.next;
    }

    if (!nextUrl) {
      var linkHeader = resp.headers.get('link') || '';
      var nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) {
        nextUrl = nextMatch[1];
      }
    }

    url = nextUrl;
    page++;
  }

  if (page >= maxPages) {
    console.log('[models] WARNING: hit max pages (' + maxPages + ') for ' + provider.prefix);
  }

  console.log('[models] total models loaded for ' + provider.prefix + ': ' + allModels.length);
  return allModels;
}

function extractModels(json) {
  if (Array.isArray(json.data)) {
    return json.data.map(function(m) {
      return {
        id: m.id || m.name || String(m),
        created: m.created,
        owned_by: m.owned_by
      };
    });
  }
  if (Array.isArray(json)) {
    return json.map(function(m) {
      return typeof m === 'string' ? { id: m } : { id: m.id || m.name || String(m) };
    });
  }
  for (var k in json) {
    var v = json[k];
    if (Array.isArray(v) && v.length > 0) {
      return v.map(function(m) {
        return typeof m === 'string' ? { id: m } : { id: m.id || m.name || String(m) };
      });
    }
  }
  return [];
}
