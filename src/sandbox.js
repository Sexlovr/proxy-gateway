// sandbox.js — plain module loader with hot-reload. No VM isolation.
//
// Provider can ship sandbox code as:
//   (a) inline string: provider.sandbox_code  (most common via dashboard)
//   (b) file slug:     provider.sandbox_file  ("ms.js" -> ./sandboxes/ms.js)
//   (c) neither set:   the built-in passthrough default in ./defaultSandbox.js
//
// sandboxes are loaded as plain Node modules — they can `require()` any
// stdlib (net, ws, fs, child_process, http, tls, https, crypto, dns, ...)
// or any package installed in the proxy container's package.json.
//
// Hot-reload: re-reads file on every serve from disk if mtime changed
// (file-backed sandboxes); inline-string sandboxes are cached by source
// hash so editing the dashboard code immediately invalidates the cache.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SANDBOXES_DIR = path.join(__dirname, '..', 'sandboxes');
const _require = createRequire(import.meta.url);                          // require for sandbox files; respects .cjs/.js ext

const inlineCache = new Map();            // prefix -> { exports, sourceHash, ts }
const fileCache = new Map();               // fileName -> { exports, mtime, ts }
const fileWatchers = new Map();            // fileName -> watcher (debounce handle)

let _defaultSandbox = null;
let _defaultSandboxLoading = false;

export async function loadSandbox(provider) {
  // (a) inline-string
  if (provider.sandbox_code && provider.sandbox_code.trim()) {
    return await _resolveInline(provider.prefix, provider.sandbox_code);
  }
  // (b) file slug
  if (provider.sandbox_file && typeof provider.sandbox_file === 'string') {
    return await _resolveFile(provider.sandbox_file);
  }
  // (c) default
  return await _resolveDefault();
}

// ── Inline evalling ──────────────────────────────────────────────────
//
// We compile the source as a CommonJS module (so `module.exports = ...` is
// the disc shape) into a fresh in-memory module whose `require` is the
// real Node `require` — full stdlib access. Errors get surfaced as
// throw on load and the inline cache entry is left invalid so the next
// call has to retry.
//
// The ProxyGateway is a trusted application and dashboards remain behind
// `verifyPassword()` on the admin endpoints (see auth.js). Do not expose
// this service to the open web without an admin auth wall.

async function _resolveInline(prefix, source) {
  const sourceHash = crypto.createHash('sha256').update(source).digest('hex');
  const cached = inlineCache.get(prefix);
  if (cached && cached.sourceHash === sourceHash) return cached.exports;

  // Wrap into a CommonJS module source
  const wrappedSource = '(function (exports, require, module, __filename, __dirname) {\n' + source + '\n})';

  let fn;
  try {
    fn = eval(wrappedSource);
  } catch (err) {
    throw new Error('sandbox_code parse error: ' + err.message);
  }

  const m = { exports: {} };
  const fakePath = path.join(SANDBOXES_DIR, 'inline-' + prefix + '.js');
  try {
    fn(m.exports, _require, m, fakePath, path.dirname(fakePath));
  } catch (err) {
    throw new Error('sandbox_code top-level throw: ' + err.message);
  }

  if (typeof m.exports !== 'function' && (typeof m.exports !== 'object' || typeof m.exports.request !== 'function')) {
    throw new Error('sandbox_code must export either an async function `request(ctx)` or an object `{ request: async function (ctx) {} }`');
  }

  const exportsObj = (typeof m.exports === 'function')
    ? { request: m.exports }
    : m.exports;

  inlineCache.set(prefix, { exports: exportsObj, sourceHash, ts: Date.now() });
  return exportsObj;
}

// ── File-backed loader ───────────────────────────────────────────────
//
// `provider.sandbox_file = "ms.cjs"` is resolved as `./sandboxes/ms.cjs` —
// always CommonJS via Node's require(). In a package.json `"type":"module"`
// tree (as this proxy is), `.js` files are ESM and would fail the require().
// Make sure files under sandboxes/ end in `.cjs`. We also try a `.cjs`
// fallback if the user passes "ms.js" and the .js loader fails.

async function _resolveFile(fileName) {
  let filePath = path.join(SANDBOXES_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    // try filename+".cjs" as fallback (e.g. "ms" -> "ms.cjs")
    const candCjs = filePath.endsWith('.cjs')
      ? null
      : (path.extname(filePath)
          ? filePath.replace(/\.[^.]+$/, '.cjs')
          : filePath + '.cjs');
    if (candCjs && fs.existsSync(candCjs)) {
      filePath = candCjs;
    } else {
      throw new Error('sandbox_file not found: ' + fileName);
    }
  }
  const stat = fs.statSync(filePath);
  const cacheKey = filePath;                                     // cache by absolute path
  const cached = fileCache.get(cacheKey);

  if (cached && cached.mtime === stat.mtimeMs) {
    return cached.exports;
  }

  // Bust require cache (CommonJS require caches by filename)
  try { delete _require.cache[_require.resolve(filePath)]; } catch (_) {}
  let mod;
  try {
    mod = _require(filePath);
  } catch (err) {
    // If .js and ESM conflict — retry by re-reading the file's source in a
    //   CJS wrapper so ESM-only package boundaries don't break us.
    if (err && (err.code === 'ERR_REQUIRE_ESM' || err.message.indexOf('Cannot use import statement outside') !== -1)) {
      try {
        const src = fs.readFileSync(filePath, 'utf8');
        const wrapped = '(function (exports, require, module, __filename, __dirname) {\n' + src + '\n})';
        const fn = eval(wrapped);
        const m = { exports: {} };
        fn(m.exports, _require, m, filePath, path.dirname(filePath));
        mod = m.exports;
      } catch (e2) {
        throw new Error('sandbox_file ' + fileName + ' (ESM-fallback) load failed: ' + e2.message);
      }
    } else {
      throw new Error('sandbox_file load error (' + fileName + '): ' + err.message);
    }
  }

  if (typeof mod !== 'function' && (typeof mod !== 'object' || typeof mod.request !== 'function')) {
    throw new Error('sandbox_file ' + fileName + ' must export either an async function `request(ctx)` or an object `{ request: async function () {} }`');
  }
  const exportsObj = (typeof mod === 'function')
    ? { request: mod, default: mod }
    : mod;
  fileCache.set(cacheKey, { exports: exportsObj, mtime: stat.mtimeMs, ts: Date.now() });
  return exportsObj;
}

// ── Default passthrough ──────────────────────────────────────────────

async function _resolveDefault() {
  if (_defaultSandbox) return _defaultSandbox;
  if (_defaultSandboxLoading) {
    // Spin briefly to coalesce concurrent first-time loaders
    while (_defaultSandboxLoading) await new Promise((r) => setTimeout(r, 5));
    return _defaultSandbox;
  }
  _defaultSandboxLoading = true;
  try {
    const mod = await import('./defaultSandbox.js');
    if (!mod || typeof mod.request !== 'function') throw new Error('defaultSandbox.js must export { request: async function () {} }');
    _defaultSandbox = mod;
    return _defaultSandbox;
  } finally {
    _defaultSandboxLoading = false;
  }
}

// ── Sandbox listing helper (for /sandbox/files endpoint) ────────────

export function listSandboxFiles() {
  if (!fs.existsSync(SANDBOXES_DIR)) return [];
  return fs.readdirSync(SANDBOXES_DIR)
    .filter((f) => f.endsWith('.js') || f.endsWith('.cjs'))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(SANDBOXES_DIR, f)).mtimeMs }));
}

export function readSandboxFile(fileName) {
  const filePath = path.join(SANDBOXES_DIR, fileName);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

// Drop cache entry to force reload on next request (called by PUT/POST
// when sandbox_code changes)
export function invalidate(prefix) {
  inlineCache.delete(prefix);
}
export function invalidateFile(fileName) {
  fileCache.delete(fileName);
}
