// kv.js — per-provider file-backed key/value store.
//
// One namespace per provider.prefix under /app/data/kv/<prefix>/.
// Each key is one file on disk. Values are Buffer|string|JSON-able.
// Synchronous reads, sequential writes (file locks not needed; MANIFEST
// is kept in memory between calls to avoid disk re-scan).
//
// Used by sandbox code via ctx.store to keep per-provider long-lived state
// (rate-limit cooldowns, model cache, session tokens, anything else).

import fs from 'fs';
import path from 'path';

// KV storage dir alignment: prefer `KV_DATA_DIR` if explicit; otherwise fall
// back to `<DATA_DIR>/kv` so per-provider sandbox state survives factory
// rebuilds exactly like providers.json on the live HF Space (Dockerfile
// sets `DATA_DIR=/data`). The historical `/app/data/kv` default is kept
// only when `DATA_DIR` is absent to preserve bare-env behaviour.
const KV_DATA_DIR = process.env.KV_DATA_DIR
  || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'kv')
      : (process.env.HF_HOME ? path.join(process.env.HF_HOME, 'kv')
          : '/app/data/kv'));
const stores = new Map();                                                      // prefix → KV instance

export function openStore(prefix) {
  if (stores.has(prefix)) return stores.get(prefix);
  const dir = path.join(KV_DATA_DIR, prefix);
  function ensureDir() { if (!fs.existsSync(dir)) try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* concurrency; ok */ } }
  ensureDir();

  const safeName = (k) => Buffer.from(String(k)).toString('hex');

  const store = {
    async get(key) {
      const p = path.join(dir, safeName(key));
      try { return fs.readFileSync(p); } catch (e) { return null; }
    },
    async getJSON(key, dflt = null) {
      const buf = await this.get(key);
      if (!buf) return dflt;
      try { return JSON.parse(buf.toString('utf8')); } catch (e) { return dflt; }
    },
    async set(key, value) {
      ensureDir();
      const p = path.join(dir, safeName(key));
      const buf = Buffer.isBuffer(value) ? value
                  : (typeof value === 'string') ? Buffer.from(value, 'utf8')
                  : Buffer.from(JSON.stringify(value), 'utf8');
      try { fs.writeFileSync(p, buf); } catch (e) { /* quota / IO fail rare */ }
    },
    async del(key) {
      const p = path.join(dir, safeName(key));
      try { fs.unlinkSync(p); } catch (e) { /* fine if missing */ }
    },
    list(prefixFilter = '') {
      try {
        return fs.readdirSync(dir).map((n) => {
          try { return Buffer.from(n, 'hex').toString('utf8'); } catch (e) { return null; }
        }).filter((n) => n !== null && n.startsWith(prefixFilter));
      } catch (e) { return []; }
    },
    dir() { return dir; },
  };

  stores.set(prefix, store);
  return store;
}

export function _resetForTest() { stores.clear(); }
