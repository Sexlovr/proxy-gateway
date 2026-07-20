// sandboxLoader.js
//
// Loads external sandbox code files from ./sandboxes/*.js (or a configured dir).
// Hot-reloaded via fs.watch with 500ms debounce so editing a file live-updates the
// sandbox without restart.
//
// Provider config can choose `sandbox_file: "myprovider.js"` (file in sandbox dir)
// to load a file-based sandbox instead of the inline `sandbox_code` string.
//
// On reload errors, we keep the last-good code and capture an error string that
// proxy will surface via the `x-sandbox-error` header on the next request.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

var __dirname = path.dirname(fileURLToPath(import.meta.url));

var SANDBOX_DIR = process.env.SANDBOX_DIR || path.join(__dirname, '..', 'sandboxes');

var cache = {
  // filename -> { code: string, error: string|null, mtime: number, loading: bool }
};

var initialized = false;
var watchHandle = null;
var reloadDebounceTimer = null;
var reloadQueue = new Set();

function ensureDir() {
  try {
    fs.mkdirSync(SANDBOX_DIR, { recursive: true });
    return true;
  } catch (e) {
    console.error('[sandboxLoader] could not create sandbox dir:', SANDBOX_DIR, e.message);
    return false;
  }
}

export function getSandboxDir() { return SANDBOX_DIR; }

export function initSandboxLoader() {
  if (initialized) return;
  if (!ensureDir()) return;
  initialized = true;

  // Initial load of all .js files
  loadAllFromDisk();

  try {
    watchHandle = fs.watch(SANDBOX_DIR, { recursive: false }, function (eventType, filename) {
      if (!filename || !filename.endsWith('.js')) return;
      reloadQueue.add(filename);
      scheduleReload();
    });
  } catch (e) {
    console.error('[sandboxLoader] fs.watch failed; hot-reload disabled:', e.message);
  }

  console.log('[sandboxLoader] initialized. dir:', SANDBOX_DIR);
}

function scheduleReload() {
  if (reloadDebounceTimer) return;
  reloadDebounceTimer = setTimeout(function () {
    reloadDebounceTimer = null;
    var queue = Array.from(reloadQueue);
    reloadQueue.clear();
    for (var i = 0; i < queue.length; i++) reloadOneFile(queue[i]);
  }, 500);
}

function loadAllFromDisk() {
  try {
    var files = fs.readdirSync(SANDBOX_DIR);
    for (var i = 0; i < files.length; i++) {
      if (!files[i].endsWith('.js')) continue;
      reloadOneFile(files[i]);
    }
  } catch (e) {
    console.error('[sandboxLoader] could not list sandbox dir:', e.message);
  }
}

function reloadOneFile(filename) {
  var fullPath = path.join(SANDBOX_DIR, filename);
  try {
    var stat = fs.statSync(fullPath);
    if (!stat.isFile()) return;
    if (cache[filename] && cache[filename].mtime === stat.mtimeMs) return;

    var code = fs.readFileSync(fullPath, 'utf-8');
    if (code.length > (256 * 1024)) {
      console.error('[sandboxLoader] file too large, refused:', filename);
      cache[filename] = { code: cache[filename] ? cache[filename].code : '', error: 'file too large', mtime: stat.mtimeMs };
      return;
    }
    cache[filename] = { code: code, error: null, mtime: stat.mtimeMs };
    console.log('[sandboxLoader] loaded', filename, '(' + code.length + ' bytes)');
  } catch (e) {
    if (cache[filename]) {
      cache[filename].error = 'reload failed: ' + e.message;
      console.error('[sandboxLoader] reload failed for', filename, ':', e.message);
    } else {
      // likely just deleted; drop the entry
      delete cache[filename];
      console.log('[sandboxLoader] removed', filename);
    }
  }
}

export function getSandboxCode(filename) {
  if (!filename) return null;
  // sanitise so callers can't escape the sandbox dir
  if (filename.indexOf('/') !== -1 || filename.indexOf('\\') !== -1 || filename.indexOf('..') !== -1) {
    return { error: 'invalid filename' };
  }
  if (!filename.endsWith('.js')) filename = filename + '.js';

  var entry = cache[filename];
  if (!entry) {
    // try a one-shot load (file may be there but cache cold)
    try {
      reloadOneFile(filename);
      entry = cache[filename];
    } catch (e) { return null; }
  }
  if (!entry) return null;
  if (entry.error) return { error: entry.error };
  return { code: entry.code };
}

export function listSandboxFiles() {
  return Object.keys(cache).filter(function (k) { return !!cache[k] && !cache[k].error; });
}
