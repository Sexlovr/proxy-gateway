import fs from 'fs/promises';
import path from 'path';

var DATA = process.env.DATA_DIR || path.join(process.cwd(), 'data');

var FILES = {
  providers: path.join(DATA, 'providers.json'),
  stats: path.join(DATA, 'stats.json'),
  history: path.join(DATA, 'history.json'),
};

var defaults = {
  providers: {},
  stats: {
    totalRequests: 0,
    totalErrors: 0,
    uniqueIps: [],
    providers: {},
  },
  history: {},
};

var cache = {
  providers: null,
  stats: null,
  history: null,
};

export async function initStorage() {
  await fs.mkdir(DATA, { recursive: true });
  console.log('[storage] data dir:', DATA);

  for (var key in FILES) {
    try {
      var raw = await fs.readFile(FILES[key], 'utf-8');
      cache[key] = JSON.parse(raw);
      console.log('[storage] loaded ' + key + ' from disk');
    } catch (e) {
      cache[key] = JSON.parse(JSON.stringify(defaults[key]));
      await persist(key);
      console.log('[storage] created default ' + key);
    }
  }

  setInterval(function() { persist('stats'); }, 30000);
}

async function persist(key) {
  try {
    await fs.writeFile(FILES[key], JSON.stringify(cache[key], null, 2), 'utf-8');
  } catch (e) {
    console.error('[storage] persist ' + key + ' failed:', e.message);
  }
}

export function getAllProviders() {
  return cache.providers || {};
}

export function getProvider(prefix) {
  return (cache.providers || {})[prefix] || null;
}

export function getVisibleProviders() {
  var result = {};
  var all = cache.providers || {};
  for (var key in all) {
    if (!all[key].cloaked) {
      result[key] = all[key];
    }
  }
  return result;
}

export function getCloakedProvidersList() {
  var result = [];
  var all = cache.providers || {};
  for (var key in all) {
    if (all[key].cloaked) {
      result.push({
        prefix: key,
        cloak_name: all[key].cloak_name || 'Unnamed',
      });
    }
  }
  return result;
}

export async function addProvider(provider) {
  var prefix = provider.prefix;
  if (cache.providers[prefix]) {
    return { ok: false, reason: 'Prefix "' + prefix + '" already exists. Pick another.' };
  }

  provider.cloaked = provider.cloaked || false;
  provider.cloak_name = provider.cloak_name || '';
  provider.cloak_password = provider.cloak_password || '';
  provider.think_config = provider.think_config || null;
  provider.search_config = provider.search_config || null;
  provider.sandbox_code = provider.sandbox_code || null;
  provider.sandbox_file = provider.sandbox_file || null;
  provider.allowed_hosts = Array.isArray(provider.allowed_hosts) ? provider.allowed_hosts : [];

  cache.providers[prefix] = Object.assign({}, provider, {
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  await persist('providers');

  if (!cache.history[prefix]) cache.history[prefix] = [];
  cache.history[prefix].push({
    timestamp: new Date().toISOString(),
    action: 'created',
    snapshot: JSON.parse(JSON.stringify(provider)),
  });
  await persist('history');

  if (!cache.stats.providers[prefix]) {
    cache.stats.providers[prefix] = { requests: 0, errors: 0, uniqueIps: [] };
  }
  await persist('stats');

  return { ok: true };
}

export async function updateProvider(prefix, updates) {
  var existing = cache.providers[prefix];
  if (!existing) return { ok: false, reason: 'Provider "' + prefix + '" not found.' };

  var changes = {};
  for (var k in updates) {
    if (JSON.stringify(existing[k]) !== JSON.stringify(updates[k])) {
      changes[k] = { from: existing[k], to: updates[k] };
      existing[k] = updates[k];
    }
  }
  existing.updated_at = new Date().toISOString();
  await persist('providers');

  cache.history[prefix] = cache.history[prefix] || [];
  cache.history[prefix].push({
    timestamp: new Date().toISOString(),
    action: 'edited',
    changes: changes,
  });
  await persist('history');

  return { ok: true, changes: changes };
}

export async function deleteProvider(prefix) {
  if (!cache.providers[prefix]) return { ok: false, reason: 'Provider "' + prefix + '" not found.' };
  delete cache.providers[prefix];
  await persist('providers');
  return { ok: true };
}

export async function cloakProvider(prefix, cloak_name, cloak_password) {
  var p = cache.providers[prefix];
  if (!p) return { ok: false, reason: 'Provider not found.' };
  p.cloaked = true;
  p.cloak_name = cloak_name || p.name || 'Unnamed';
  p.cloak_password = cloak_password;
  p.updated_at = new Date().toISOString();
  await persist('providers');
  return { ok: true };
}

export async function uncloakProvider(prefix) {
  var p = cache.providers[prefix];
  if (!p) return { ok: false, reason: 'Provider not found.' };
  p.cloaked = false;
  p.updated_at = new Date().toISOString();
  await persist('providers');
  return { ok: true };
}

export function getHistory(prefix) {
  return (cache.history || {})[prefix] || [];
}

export function getStats() {
  return cache.stats || defaults.stats;
}

export function recordRequest(prefix, ip, errored, endpointType) {
  errored = errored || false;
  cache.stats.totalRequests++;
  if (errored) cache.stats.totalErrors++;
  if (cache.stats.uniqueIps.indexOf(ip) === -1) cache.stats.uniqueIps.push(ip);

  if (prefix) {
    if (!cache.stats.providers[prefix]) {
      cache.stats.providers[prefix] = { requests: 0, errors: 0, uniqueIps: [], endpoints: {} };
    }
    var p = cache.stats.providers[prefix];
    p.requests++;
    if (errored) p.errors++;
    if (p.uniqueIps.indexOf(ip) === -1) p.uniqueIps.push(ip);
    if (endpointType) {
      if (!p.endpoints) p.endpoints = {};
      p.endpoints[endpointType] = (p.endpoints[endpointType] || 0) + 1;
    }
  }
}

var modelsCache = {};

export function getCachedModels(prefix) {
  return modelsCache[prefix] || null;
}

export function setCachedModels(prefix, models) {
  modelsCache[prefix] = { models: models, fetchedAt: Date.now() };
}

export function getAllCachedModels() {
  return modelsCache;
}
