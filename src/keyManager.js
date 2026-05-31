const counters = {};

export function parseCompoundKeys(raw) {
  if (!raw) return {};
  const cleaned = raw.replace(/^\s*(Bearer|Basic|Token)\s+/i, '').trim();
  if (!cleaned) return {};

  const result = {};
  const segments = cleaned.split(';');

  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    const eqIdx = seg.indexOf('=');
    if (eqIdx === -1) continue;
    
    const prefix = seg.slice(0, eqIdx).trim().toLowerCase();
    const keys = seg.slice(eqIdx + 1).split(',').map(k => k.trim()).filter(Boolean);
    
    if (prefix && keys.length) {
      // FIX: Check if we already have keys for this prefix, if so, append them!
      if (!result[prefix]) {
        result[prefix] = [];
      }
      result[prefix] = result[prefix].concat(keys);
    }
  }

  return result;
}

export function getNextKey(prefix, keys, skip = new Set()) {
  if (!keys || keys.length === 0) return null;
  if (!(prefix in counters)) counters[prefix] = 0;

  const total = keys.length;
  for (let attempt = 0; attempt < total; attempt++) {
    const idx = (counters[prefix] + attempt) % total;
    if (skip.has(idx)) continue;
    
    // Advance the counter for the next request
    counters[prefix] = (idx + 1) % total;
    
    var rawKey = keys[idx];
    var actualKey = rawKey;
    var proxyUrl = null;

    // Check if the user attached a forward proxy IP to this specific key
    var pipeIdx = rawKey.indexOf('|');
    if (pipeIdx !== -1) {
      actualKey = rawKey.slice(0, pipeIdx);
      proxyUrl = rawKey.slice(pipeIdx + 1);
    }

    return { 
      key: actualKey, 
      index: idx, 
      proxyUrl: proxyUrl, 
      rawKey: rawKey 
    };
  }

  return null;
}
