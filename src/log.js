// log.js — tiny structured logger bound to request id + provider prefix.
// Plugins sandbox code through ctx.log; admin code via `log` directly.
//
// API is pino-style and accepts both forms:
//   log.error({ meta: 'object' }, 'message string')
//   log.error('message string', { meta: 'object' })
//   log.error('message string without meta')
//   log.error({ only: 'meta' })  // no message; treated as meta + msg omitted
// The first token in argument order that's a string is treated as `msg`,
// the first token that's an object is treated as `meta`. (Numbers /
// booleans are coerced into meta if both args are scalars.)

import { getAllProviders, getProvider, addProvider, updateProvider, deleteProvider } from './storage.js';
import { verifyPassword } from './auth.js';
import { invalidate } from './sandbox.js';

let _seq = 0;
function nextSeq() { _seq = (_seq + 1) % 0xffff; return _seq; }

function normalizePinoArgs(a, b) {
  // Detect pino-style: meta object + message string (in either order).
  // Falls back gracefully for string-only / object-only / no-arg forms.
  if (a == null && b == null) return { msg: undefined, meta: {} };
  const aIsStr = typeof a === 'string';
  const bIsStr = typeof b === 'string';
  const aIsObj = a !== null && typeof a === 'object' && !Array.isArray(a);
  const bIsObj = b !== null && typeof b === 'object' && !Array.isArray(b);
  if (aIsStr && bIsObj) return { msg: a, meta: b };                 // log.x('msg', {...})
  if (aIsObj && bIsStr) return { msg: b, meta: a };                 // log.x({...}, 'msg') — pino
  if (aIsStr && b == null) return { msg: a, meta: {} };             // log.x('msg')
  if (aIsObj && b == null) return { msg: undefined, meta: a };     // log.x({...}) — meta only
  // Both strings? treat first as msg, second as a weird scalar meta.
  if (aIsStr && bIsStr) return { msg: a, meta: { value: b } };
  // Last-ditch fallbacks
  if (a != null && b == null) return { msg: String(a), meta: {} };
  return { msg: a == null ? undefined : String(a), meta: b == null ? {} : (b || {}) };
}

const _baseLogger = {
  _bind: {},
  child(bindings) {
    return Object.assign({}, this, { _bind: Object.assign({}, this._bind, bindings) });
  },
  _write(level, msgOrMeta, metaOrMsg) {
    const { msg, meta } = normalizePinoArgs(msgOrMeta, metaOrMsg);
    const line = JSON.stringify({ seq: nextSeq(), ts: Date.now(), level, msg, ...this._bind, ...meta });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  },
  info(a, b)  { this._write('info',  a, b); },
  warn(a, b)  { this._write('warn',  a, b); },
  error(a, b) { this._write('error', a, b); },
  debug(a, b) { this._write('debug', a, b); },
};

export const log = _baseLogger.child({});

// ── ctx.proxy:* — call-backs into the proxy admin (sandbox controls proxy) ──
// Storage writes are forwarded to the existing storage.js module so the
// admin REST endpoints AND the sandbox callbacks share one source of truth.

export const proxyAdminApi = {
  async listProviders()               { return getAllProviders(); },
  async getProvider(prefix)           { return getProvider(prefix); },
  async addProvider(cfg)              {
    const r = await addProvider(cfg);
    if (r.ok) invalidate(cfg.prefix);
    return r;
  },
  async updateProvider(prefix, patch) {
    const r = await updateProvider(prefix, patch);
    if (r.ok) invalidate(prefix);
    return r;
  },
  async deleteProvider(prefix)        {
    const r = await deleteProvider(prefix);
    // No need to invalidate cache via this path; the SDK will see 4xx on next use.
    return r;
  },
  log(level, msg, meta)               { _baseLogger._write(level || 'info', msg, meta || {}); },

  // Background task scheduler — minimal: a setInterval that survives across
  // requests. Sandbox code that wants a periodic cron calls
  //   ctx.proxy.schedule('ms-model-refresh', 6*3600*1000, async (ctx) => {...})
  // and proxy keeps it alive until factory-reboot.
  _tasks: new Map(),
  async schedule(name, interval_ms, fn) {
    if (this._tasks.has(name)) clearInterval(this._tasks.get(name).handle);
    const handle = setInterval(() => {
      try { fn({ log: log.child({ task: name }) }); }
      catch (e) { log.error({ task: name, err: e.message }, 'scheduled task threw'); }
    }, interval_ms);
    this._tasks.set(name, { handle, fn, interval_ms, created: Date.now() });
    return { name, interval_ms, created: Date.now() };
  },
  cancelSchedule(name) {
    const t = this._tasks.get(name);
    if (t) { clearInterval(t.handle); this._tasks.delete(name); return true; }
    return false;
  },
  listSchedules() {
    return Array.from(this._tasks.entries()).map(([name, t]) => ({ name, interval_ms: t.interval_ms, created: t.created }));
  },

  // Fire-and-forget after res.end (audit log / queue drain)
  async spawnTask(fn) {
    // Fire-and-forget, runtime swallows rejections silently.
    setTimeout(() => { try { fn({ log: log.child({ spawn: true }) }); } catch (e) { /* swallow */ } }, 0);
  },

  // Stats stub (proxy never decides on throttling based on it — dashboard only)
  async stats(prefix, patch) {
    // Forward to stats.js if available
    try {
      const { recordProxyRequest } = await import('./stats.js');
      recordProxyRequest(prefix, patch.ip || '0.0.0.0', patch.err || false, patch.endpoint_type || null);
    } catch (e) { /* ignore */ }
  },
};
