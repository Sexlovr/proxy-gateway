// Test: loads the upgraded universal-contract sandbox files (aerolink.js,
// gemini.js, atxp.js) from /data/projects/sandbox-code-proxy-gate and exercises
// their request and response phases through the new sandboxRunner. Asserts
// they:
//   1. Compile successfully under the universal contract
//   2. Produce sensible request descriptors (URL, body, stream formats)
//   3. response phase correctly translates Gemini/Anthropic JSON -> OpenAI JSON
//   4. stream_chunk phase produces valid OpenAI chat.completion.chunk SSE

import fs from 'fs';
import { createSandboxSession } from '../src/sandboxRunner.js';

var FILES = {
  aerolink: '/data/projects/sandbox-code-proxy-gate/aerolink.js',
  gemini:   '/data/projects/sandbox-code-proxy-gate/gemini.js',
  atxp:     '/data/projects/sandbox-code-proxy-gate/atxp.js',
};

function summarize(o) {
  return JSON.stringify(o, (k, v) => v instanceof Buffer ? '[Buffer ' + v.length + ']' : v, 2);
}

function makeSession(code, opts) {
  opts = opts || {};
  return createSandboxSession(code, Object.assign({
    provider: { name: 'test', upstream_url: 'https://example.invalid' },
    allowedHosts: ['capi.aerolink.lat', 'generativelanguage.googleapis.com', 'api.atxp.ai', 'example.invalid'],
    perRequestTimeout: 5000,
    perFetchTimeout: 3000,
    maxChain: 1,
    log: () => {},
  }, opts));
}

async function run() {
  var allPass = true;

  console.log('=== TEST 1: aerolink.js compiles + request phase ===');
  {
    var code = fs.readFileSync(FILES.aerolink, 'utf-8');
    var s = makeSession(code, {
      req: { model: 'claude-sonnet-4-5-20250514[high]', messages: [{ role: 'user', content: 'hi' }] },
      context: { path: '/v1/chat/completions', method: 'POST', stripped_model: 'claude-sonnet-4-5-20250514[high]', original_model: 'aero:claude-sonnet-4-5-20250514[high]' },
    });
    if (!s || s.error) { console.log('  FAIL: session creation:', s && s.error); allPass = false; }
    else {
      var r = await s.dispatchRequest();
      console.log('  url_path:        ', r && r.url_path);
      console.log('  method:          ', r && r.method);
      console.log('  endpoint_type:   ', r && r.endpoint_type);
      console.log('  upstream_stream: ', r && r.upstream_stream_format);
      console.log('  downstream_stream:', r && r.downstream_stream_format);
      console.log('  retry_codes:     ', JSON.stringify(r && r.retry_codes));
      console.log('  body.model:      ', r && r.body && r.body.model);
      console.log('  body.thinking:   ', JSON.stringify(r && r.body && r.body.thinking));
      console.log('  body.messages:   ', JSON.stringify(r && r.body && r.body.messages));
      console.log('  headers.auth:    ', r && r.headers && r.headers['authorization']);
      var pass = r && r.url_path === '/v1/messages?beta=true'
        && r.method === 'POST'
        && r.body && r.body.model === 'claude-sonnet-4-5-20250514'
        && r.body.thinking && r.body.thinking.budget_tokens === 32000
        && r.headers['authorization'] === 'Bearer {{KEY}}'
        && r.headers['x-api-key'] === '{{KEY}}';
      console.log('  ', pass ? 'PASS' : 'FAIL');
      if (!pass) allPass = false;
    }
  }

  console.log('\n=== TEST 2: aerolink.js response phase (Anthropic -> OpenAI) ===');
  {
    var code = fs.readFileSync(FILES.aerolink, 'utf-8');
    var s = makeSession(code, {
      req: {},
      context: { stripped_model: 'claude-sonnet-4-5-20250514' },
    });
    var upperBody = JSON.stringify({
      id: 'msg_01xyz',
      model: 'claude-sonnet-4-5-20250514',
      content: [
        { type: 'thinking', thinking: 'I should answer politely.' },
        { type: 'text', text: 'Hello there!' }
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 }
    });
    var r = await s.dispatchResponse({ status: 200, headers: new Map([['content-type', 'application/json']]), bodyBuffer: Buffer.from(upperBody, 'utf8') });
    console.log('  passthrough:', r && r.passthrough);
    console.log('  body:', summarize(r && r.body));
    var pass = r && !r.passthrough && r.body
      && r.body.object === 'chat.completion'
      && r.body.choices
      && r.body.choices[0].message.content === 'Hello there!'
      && r.body.choices[0].message.reasoning_content === 'I should answer politely.'
      && r.body.choices[0].finish_reason === 'stop'
      && r.body.usage.total_tokens === 8;
    console.log('  ', pass ? 'PASS' : 'FAIL');
    if (!pass) allPass = false;
  }

  console.log('\n=== TEST 3: aerolink.js stream_chunk phase (Anthropic SSE -> OpenAI SSE) ===');
  {
    var code = fs.readFileSync(FILES.aerolink, 'utf-8');
    var s = makeSession(code, {
      req: { stream: true },
      context: { stripped_model: 'claude-sonnet-4-5-20250514', original_model: 'aero:claude-sonnet-4-5-20250514' },
    });
    // Send a sequence of Anthropic SSE events
    var events = [
      { event: 'message_start',        data: JSON.stringify({ type: 'message_start', message: { id: 'msg_01', model: 'claude-...-4-5' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }) },
      { event: 'message_delta',       data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) },
      { event: 'message_stop',        data: JSON.stringify({ type: 'message_stop' }) },
    ];
    var allOut = '';
    for (var i = 0; i < events.length; i++) {
      var r = await s.dispatchStreamChunk({
        chunkText: events[i].data, chunkIndex: i, isLast: i === events.length - 1,
        upstreamEvent: events[i].event,
      });
      if (r && r.downstream_chunk) allOut += r.downstream_chunk;
    }
    console.log('  downstream stream (per chunk-written):');
    console.log(allOut.split('\n\n').filter(Boolean).map(l => '    ' + l).join('\n'));
    var pass = allOut.indexOf('data: {') !== -1
      && allOut.indexOf('"role":"assistant"') !== -1
      && allOut.indexOf('"content":"Hello"') !== -1
      && allOut.indexOf('"content":" world"') !== -1
      && allOut.indexOf('"reasoning_content":"hmm"') !== -1
      && allOut.indexOf('"finish_reason":"stop"') !== -1;
    console.log('  ', pass ? 'PASS' : 'FAIL');
    if (!pass) allPass = false;
  }

  console.log('\n=== TEST 4: aerolink.js parses [low] model tag ===');
  {
    var code = fs.readFileSync(FILES.aerolink, 'utf-8');
    var s = makeSession(code, {
      req: { model: 'claude-opus-4-8[low]', messages: [{ role: 'user', content: 'hi' }] },
      context: { stripped_model: 'claude-opus-4-8[low]', original_model: 'aero:claude-opus-4-8[low]' },
    });
    var r = await s.dispatchRequest();
    var pass = r && r.body && r.body.model === 'claude-opus-4-8'
      && r.body.thinking && r.body.thinking.budget_tokens === 2048;
    console.log('  body.model:', r && r.body && r.body.model, '| thinking.budget:', r && r.body && r.body.thinking && r.body.thinking.budget_tokens);
    console.log('  ', pass ? 'PASS' : 'FAIL');
    if (!pass) allPass = false;
  }

  console.log('\n=== TEST 5: gemini.js compiles + request phase ===');
  {
    var code = fs.readFileSync(FILES.gemini, 'utf-8');
    var s = makeSession(code, {
      req: { messages: [{ role: 'user', content: 'hi' }], stream: true },
      context: { stripped_model: 'gemini-2.5-flash-high', original_model: 'gm:gemini-2.5-flash-high' },
    });
    var r = await s.dispatchRequest();
    console.log('  url:', r && r.url);
    console.log('  body.generationConfig.thinkingConfig:', JSON.stringify(r && r.body && r.body.generationConfig && r.body.generationConfig.thinkingConfig));
    console.log('  body.messages:', JSON.stringify(r && r.body && r.body.contents));
    var pass = r && r.body && r.url && r.url.indexOf(':streamGenerateContent?alt=sse') !== -1
      && r.body.contents.length === 1
      && r.body.contents[0].role === 'user'
      && r.body.contents[0].parts[0].text === 'hi'
      && r.body.systemInstruction === undefined
      && r.body.generationConfig.thinkingConfig.thinkingBudget === 32000;
    console.log('  ', pass ? 'PASS' : 'FAIL');
    if (!pass) allPass = false;
  }

  console.log('\n=== TEST 6: gemini.js extracts system message into systemInstruction ===');
  {
    var code = fs.readFileSync(FILES.gemini, 'utf-8');
    var s = makeSession(code, {
      req: { messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'hi' },
      ] },
      context: { stripped_model: 'gemini-2.5-flash' },
    });
    var r = await s.dispatchRequest();
    var pass = r && r.body && r.body.systemInstruction
      && r.body.systemInstruction.parts[0].text === 'You are helpful.'
      && r.body.contents[0].role === 'user';
    console.log('  sys:', r && r.body && r.body.systemInstruction && r.body.systemInstruction.parts[0].text);
    console.log('  ', pass ? 'PASS' : 'FAIL');
    if (!pass) allPass = false;
  }

  console.log('\n=== TEST 7: gemini.js response phase (Gemini JSON -> OpenAI) ===');
  {
    var code = fs.readFileSync(FILES.gemini, 'utf-8');
    var s = makeSession(code, {
      req: {},
      context: { stripped_model: 'gemini-2.5-flash', original_model: 'gm:gemini-2.5-flash' },
    });
    var upperBody = JSON.stringify({
      candidates: [{
        content: {
          parts: [
            { thought: true, text: 'Pondering...' },
            { text: 'Hello from Gemini!' }
          ]
        },
        finishReason: 'STOP'
      }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6, totalTokenCount: 10 }
    });
    var r = await s.dispatchResponse({ status: 200, headers: new Map([['content-type', 'application/json']]), bodyBuffer: Buffer.from(upperBody, 'utf8') });
    var pass = r && r.body && r.body.choices[0].message.content === 'Hello from Gemini!'
      && r.body.choices[0].message.reasoning_content === 'Pondering...'
      && r.body.choices[0].finish_reason === 'stop'
      && r.body.usage.total_tokens === 10;
    console.log('  body:', summarize(r && r.body));
    console.log('  ', pass ? 'PASS' : 'FAIL');
    if (!pass) allPass = false;
  }

  console.log('\n=== TEST 8: gemini.js stream_chunk (Gemini SSE -> OpenAI SSE) ===');
  {
    var code = fs.readFileSync(FILES.gemini, 'utf-8');
    var s = makeSession(code, {
      req: { stream: true },
      context: { stripped_model: 'gemini-2.5-flash', original_model: 'gm:gemini-2.5-flash' },
    });

    var geminiFrames = [
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello ' }] } }] }),
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini!' }] } }] }),
      JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }),
    ];
    var out = '';
    for (var i = 0; i < geminiFrames.length; i++) {
      var r = await s.dispatchStreamChunk({ chunkText: geminiFrames[i], chunkIndex: i, upstreamEvent: '' });
      if (r && r.downstream_chunk) out += r.downstream_chunk;
    }
    console.log('  ', out.split('\n\n').filter(Boolean).map(l => '    ' + l).join('\n'));
    var pass = out.indexOf('"content":"Hello "') !== -1
      && out.indexOf('"content":"Gemini!"') !== -1
      && out.indexOf('"finish_reason":"stop"') !== -1;
    console.log('  ', pass ? 'PASS' : 'FAIL');
    if (!pass) allPass = false;
  }

  console.log('\n=== TEST 9: atxp.js compiles + applies reasoning_effort ===');
  {
    var code = fs.readFileSync(FILES.atxp, 'utf-8');
    var s = makeSession(code, {
      req: { model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] },
      context: { stripped_model: 'gpt-5-high', original_model: 'atxp:gpt-5-high' },
    });
    var r = await s.dispatchRequest();
    var pass = r && r.body && r.body.model === 'gpt-5'  // tag stripped
      && r.body.reasoning_effort === 'high'
      && r.handled.think === true
      && r.endpoint_type === 'chat';
    console.log('  body.model:', r && r.body && r.body.model);
    console.log('  reasoning_effort:', r && r.body && r.body.reasoning_effort);
    console.log('  handled:', JSON.stringify(r && r.handled));
    console.log('  ', pass ? 'PASS' : 'FAIL');
    if (!pass) allPass = false;
  }

  console.log('\n=== TEST 10: atxp.js numeric thinking maps to a bucket ===');
  {
    var code = fs.readFileSync(FILES.atxp, 'utf-8');
    var s = makeSession(code, {
      req: { messages: [{ role: 'user', content: 'hi' }] },
      context: { stripped_model: 'gpt-5-5000' },
    });
    var r = await s.dispatchRequest();
    var pass = r && r.body && r.body.reasoning_effort === 'medium' && r.handled.think === true;
    console.log('  reasoning_effort:', r && r.body && r.body.reasoning_effort);
    console.log('  ', pass ? 'PASS' : 'FAIL');
    if (!pass) allPass = false;
  }

  console.log('\n==============================');
  console.log(allPass ? 'ALL TESTS PASS' : 'SOME TESTS FAILED');
  console.log('==============================');
  process.exit(allPass ? 0 : 1);
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
