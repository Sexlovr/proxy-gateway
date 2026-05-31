import vm from 'vm';
import { randomUUID } from 'crypto';

// Safe Buffer proxy — only expose encoding/decoding, no file I/O
var SafeBuffer = {
from: function(data, encoding) { return Buffer.from(data, encoding); },
alloc: function(size) { return Buffer.alloc(size); },
allocUnsafe: function(size) { return Buffer.allocUnsafe(size); },
concat: function(list, length) { return Buffer.concat(list, length); },
isBuffer: function(obj) { return Buffer.isBuffer(obj); },
byteLength: function(str, enc) { return Buffer.byteLength(str, enc); },
};

export function runSandboxCode(code, reqBody, features, provider, requestContext, expressReq, expressRes) {
var result = {
body: reqBody,
handled: {},
url: null,
url_path: null,
headers: null,
method: null,
response_format: null,
response_parser: null,
stream_content_type: null,
retry_codes: null,
timeout: null,
hijacked: false,
error: null
};

if (!code || typeof code !== 'string' || !code.trim()) {
return result;
}

try {
var cleanCode = code.trim();

// NATIVE MODULE WRAPPER: Safely supports helper functions and standard module.exports
var wrapper = `
var module = { exports: {} };
var exports = module.exports;
${cleanCode}
__result = (typeof module.exports === 'function') ? module.exports(__req, __features, __provider, __context, __expressReq, __expressRes) : null;
`;

var safeReq = JSON.parse(JSON.stringify(reqBody));
var safeFeatures = JSON.parse(JSON.stringify(features));
var safeProvider = {
prefix: provider.prefix,
name: provider.name,
upstream_url: provider.upstream_url,
auth_type: provider.auth_type,
auth_header: provider.auth_header || 'authorization',
models_endpoint: provider.models_endpoint || '/v1/models'
};
var safeContext = {
path: (requestContext && requestContext.path) || '/v1/chat/completions',
method: (requestContext && requestContext.method) || 'POST',
original_model: (requestContext && requestContext.original_model) || '',
stripped_model: (requestContext && requestContext.stripped_model) || '',
};

var safeExpressReq = null;
if (expressReq) {
safeExpressReq = {
method: expressReq.method,
path: expressReq.path,
url: expressReq.url,
headers: expressReq.headers,
query: expressReq.query,
ip: expressReq.ip,
body: reqBody
};
}

var safeExpressRes = null;
if (expressRes) {
safeExpressRes = {
status: function(c) { expressRes.status(c); return safeExpressRes; },
send: function(d) { expressRes.send(d); return safeExpressRes; },
json: function(d) { expressRes.json(d); return safeExpressRes; },
setHeader: function(k, v) { expressRes.setHeader(k, v); return safeExpressRes; },
end: function(d) { expressRes.end(d); },
write: function(d) { expressRes.write(d); }
};
}

var context = vm.createContext({
__req: safeReq,
__features: safeFeatures,
__provider: safeProvider,
__context: safeContext,
__expressReq: safeExpressReq,
__expressRes: safeExpressRes,
__result: null,
// Core types
JSON: JSON, Array: Array, Object: Object, String: String, Number: Number, Math: Math,
parseInt: parseInt, parseFloat: parseFloat, isNaN: isNaN, isFinite: isFinite,
Date: Date, RegExp: RegExp, Error: Error, Boolean: Boolean, Map: Map, Set: Set,
// URI encoding
encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
encodeURI: encodeURI, decodeURI: decodeURI,
// URL utilities — essential for building API URLs
URL: URL, URLSearchParams: URLSearchParams,
// Binary / encoding — needed for auth flows, signing, base64
Buffer: SafeBuffer,
TextEncoder: TextEncoder, TextDecoder: TextDecoder,
btoa: function(s) { return Buffer.from(String(s), 'binary').toString('base64'); },
atob: function(s) { return Buffer.from(String(s), 'base64').toString('binary'); },
// Crypto basics — UUIDs for request IDs, no signing/hashing exposed
crypto: { randomUUID: randomUUID },
// Timing shim — runs synchronously (no real async in sandbox)
setTimeout: function(fn) { if (typeof fn === 'function') fn(); },
clearTimeout: function() {},
// Console — captures logs for error surfacing
console: {
log: function() {},
error: function() {},
warn: function() {},
info: function() {}
}
});

var script = new vm.Script(wrapper);
script.runInContext(context, { timeout: 5000 });

if (context.__result) {
var r = context.__result;
if (r.hijacked) {
result.hijacked = true;
return result;
}
if (r.body) {
result.body = r.body;
} else if (!r.handled && !r.url && !r.url_path && !r.headers && !r.method && !r.response_format && !r.response_parser) {
result.body = r;
}
if (r.handled) result.handled = r.handled;
if (r.url) result.url = String(r.url);
if (r.url_path) result.url_path = String(r.url_path);
if (r.method) result.method = String(r.method).toUpperCase();
if (r.response_format) result.response_format = String(r.response_format).toLowerCase();
if (r.response_parser) result.response_parser = String(r.response_parser);
if (r.stream_content_type) result.stream_content_type = String(r.stream_content_type).toLowerCase();
if (r.retry_codes && Array.isArray(r.retry_codes)) result.retry_codes = r.retry_codes;
if (r.timeout && !isNaN(Number(r.timeout))) result.timeout = Number(r.timeout);
if (r.headers && typeof r.headers === 'object') {
result.headers = {};
for (var hk in r.headers) result.headers[hk.toLowerCase()] = String(r.headers[hk]);
}
}
} catch (e) {
console.error('[sandbox-code] execution error:', e.message);
result.body = reqBody;
result.handled = {};
result.error = e.message;
}

return result;
}
