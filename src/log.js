// log.js — tiny structured logger bound to request id + provider prefix.
// Plugins sandbox code through ctx.log; admin code via `log` directly.

import { getAllProviders, getProvider, addProvider, updateProvider, deleteProvider } from './storage.js';
import { verifyPassword } from './auth.js';
import { invalidate } from './sandbox.js';

let _seq = 0;
function nextSeq() { _seq = (_seq + 1) % 0xffff; return _seq; }

const _baseLogger = {
  _bind: {},
  child(bindings) {
    return Object.assign({}, this, { _bind: Object.assign({}, this._bind, bindings) });
  },
  _write(level, msg, meta) {
    const line = JSON.stringify({ seq: nextSeq(), ts: Date.now(), level, msg, ...this._bind, ...meta });
    // pino-ish single-line JSON; streamed to STDOUT.
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  },
  info(msg, meta)  { this._write('info',  msg, meta || {}); },
  warn(msg, meta)  { this._write('warn',  msg, meta || {}); },
  error(msg, meta) { this._write('error', msg, meta || {}); },
  debug(msg, meta) { this._write('debug', msg, meta || {}); },
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
