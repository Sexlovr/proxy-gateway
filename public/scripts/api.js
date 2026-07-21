// api.js — thin fetch wrapper with retry + error normalization.
export const API = '';

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export async function api(path, opts = {}) {
  const url = API + path;
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    throw new ApiError(e.message || 'Network error');
  }
  let body;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { body = await res.json(); } catch { body = {}; }
  } else {
    try { body = await res.text(); } catch { body = ''; }
  }
  if (!res.ok) {
    const msg = (body && typeof body === 'object' && (body.error || body.message)) || `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, body);
  }
  return body;
}

export function get(path, opts) {
  return api(path, { method: 'GET', ...opts });
}
export function post(path, data, opts) {
  return api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof data === 'string' ? data : JSON.stringify(data),
    ...opts,
  });
}
export function put(path, data, opts) {
  return api(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: typeof data === 'string' ? data : JSON.stringify(data),
    ...opts,
  });
}
export function del(path, data, opts) {
  return api(path, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: data ? JSON.stringify(data) : undefined,
    ...opts,
  });
}

// ---- Domain API ----

export const Providers = {
  list: () => get('/api/providers'),
  listCloaked: () => get('/api/providers/cloaked'),
  get: (prefix) => get(`/api/providers/${encodeURIComponent(prefix)}`),
  history: (prefix) => get(`/api/providers/${encodeURIComponent(prefix)}/history`),
  create: (data) => post('/api/providers', data),
  update: (prefix, data) => put(`/api/providers/${encodeURIComponent(prefix)}`, data),
  remove: (prefix, password) => del(`/api/providers/${encodeURIComponent(prefix)}`, { password }),
  cloak: (prefix, data) => post(`/api/providers/${encodeURIComponent(prefix)}/cloak`, data),
  uncloak: (prefix, data) => post(`/api/providers/${encodeURIComponent(prefix)}/uncloak`, data),
  reveal: (prefix, data) => post(`/api/providers/cloaked/${encodeURIComponent(prefix)}/reveal`, data),
};

export const Models = {
  list: () => get('/api/models'),
  fetchAll: (keys) => post('/api/models/fetch', { keys }),
  fetchOne: (prefix, key) => post(`/api/models/fetch/${encodeURIComponent(prefix)}`, { key }),
};

export const Stats = {
  get: () => get('/api/stats'),
};

export const Sandbox = {
  files: () => get('/sandbox/files'),
  file: (name) => get(`/sandbox/file/${encodeURIComponent(name)}`),
  test: (data) => post('/sandbox/test', data),
  testResponse: (data) => post('/sandbox/test_response', data),
};

// ---- localStorage helpers ----
export const Store = {
  get(key, dflt = null) {
    try { const v = localStorage.getItem(key); return v === null ? dflt : JSON.parse(v); }
    catch { return dflt; }
  },
  set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} },
  remove(key) { try { localStorage.removeItem(key); } catch {} },
  getRaw(key, dflt = '') {
    try { return localStorage.getItem(key) ?? dflt; } catch { return dflt; }
  },
  setRaw(key, val) { try { localStorage.setItem(key, val); } catch {} },
};
