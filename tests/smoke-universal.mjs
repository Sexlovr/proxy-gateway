import { spawn } from 'child_process';
import http from 'http';

const PORT = 7911;
const server = spawn('node', ['server.js'], {
  cwd: '/data/projects/proxy-gateway',
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '', err = '';
server.stdout.on('data', d => { out += d; });
server.stderr.on('data', d => { err += d; });

function get(path) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', e => resolve({ error: e.message }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

function post(path, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    }, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', e => resolve({ error: e.message }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

await new Promise(r => setTimeout(r, 6500));

console.log('=== /health ===');
console.log(JSON.stringify(await get('/health')));

console.log('=== /sandbox/files ===');
console.log(JSON.stringify(await get('/sandbox/files')));

console.log('=== /v1/models ===');
console.log(JSON.stringify(await get('/v1/models')));

console.log('=== POST /sandbox/test (legacy sandbox, expect rejection) ===');
console.log(JSON.stringify(await post('/sandbox/test', {
  code: 'module.exports = function(req, features, provider, context) { return { body: req }; };',
  req: { model: 'opn:gpt-4o', messages: [{ role: 'user', content: 'hi' }] }
})));

const universalCode = [
  'module.exports = {',
  '  universal: true,',
  '  request: function(ctx) {',
  '    return {',
  '      url: "https://api.openai.com/v1/chat/completions",',
  '      method: "POST",',
  '      body: ctx.req,',
  '      endpoint_type: "chat",',
  '      upstream_stream_format: "sse",',
  '      downstream_stream_format: "openai_chat_sse",',
  '      retry_codes: [401, 403, 429, 500, 502, 503]',
  '    };',
  '  },',
  '  response: function(ctx) {',
  '    return { passthrough: true };',
  '  }',
  '};',
].join('\n');

console.log('=== POST /sandbox/test (UNIVERSAL sandbox - request phase) ===');
console.log(JSON.stringify(await post('/sandbox/test', {
  code: universalCode,
  req: { model: 'opn:gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true },
  stream: true,
  stripped_model: 'gpt-4o'
})));

console.log('=== POST /sandbox/test_response (passthrough) ===');
console.log(JSON.stringify(await post('/sandbox/test_response', {
  code: universalCode,
  upstreamStatus: 200,
  upstreamContentType: 'application/json',
  upstreamBody: JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'hi back' } }] })
})));

const universalCode2 = [
  'module.exports = {',
  '  universal: true,',
  '  request: function(ctx) { return { body: ctx.req }; },',
  '  response: function(ctx) {',
  '    var j = ctx.upstream.bodyJson || {};',
  '    return {',
  '      status: 200,',
  '      headers: { "content-type": "application/json", "x-sandbox-touched": "1" },',
  '      body: { customEnvelope: true, originalRows: [], totalTokens: j.total_tokens || 0 }',
  '    };',
  '  }',
  '};',
].join('\n');

console.log('=== POST /sandbox/test_response (sandbox shapes downstream) ===');
console.log(JSON.stringify(await post('/sandbox/test_response', {
  code: universalCode2,
  upstreamStatus: 200,
  upstreamContentType: 'application/json',
  upstreamBody: JSON.stringify({ total_tokens: 123, choices: [{ message: { content: 'hi' } }] })
})));

console.log('=== SERVER STDOUT (trimmed) ===');
console.log(out.slice(0, 1500));
console.log('=== SERVER STDERR (trimmed) ===');
console.log(err.slice(0, 1500));

server.kill('SIGTERM');
setTimeout(() => process.exit(0), 200);
