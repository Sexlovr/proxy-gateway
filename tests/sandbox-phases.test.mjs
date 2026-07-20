import { createSandboxSession } from '../src/sandboxRunner.js';

function summarize(o) {
  return JSON.stringify(o, (k, v) => v instanceof Buffer ? '[Buffer len=' + v.length + ']' : v, 2);
}

async function run() {
  console.log('=== TEST 1: legacy sandbox code (old positional signature, NOT universal) ===');
  {
    const code = `module.exports = function(req, features, provider, context) { return { body: req }; };`;
    const session = createSandboxSession(code, {
      req: { model: 'opn:gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      provider: { name: 'test', upstream_url: 'https://api.openai.com' },
      allowedHosts: ['api.openai.com'],
      context: { path: '/v1/chat/completions', method: 'POST', stripped_model: 'gpt-4o' },
      log: () => {},
    });
    if (!session || session.error) {
      console.log('  -> session NULL (expected for legacy signature) -> proxy will fall back to LEGACY handler. Good.');
    } else {
      const r = await session.dispatchRequest();
      console.log('  request result:', summarize(r));
    }
  }

  console.log('\n=== TEST 2: UNIVERSAL sandbox - request & response phases ===');
  {
    const code = `module.exports = {
      universal: true,
      request: function(ctx) {
        return {
          url: 'https://api.openai.com/v1/chat/completions',
          method: 'POST',
          body: ctx.req,
          endpoint_type: 'chat',
          upstream_stream_format: 'sse',
          downstream_stream_format: 'openai_chat_sse',
          retry_codes: [401, 403, 429, 500, 502, 503]
        };
      },
      response: function(ctx) {
        return { passthrough: true };
      }
    };`;
    const session = createSandboxSession(code, {
      req: { model: 'opn:gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      provider: { name: 'test', upstream_url: 'https://api.openai.com' },
      allowedHosts: ['api.openai.com'],
      context: { path: '/v1/chat/completions', method: 'POST', stripped_model: 'gpt-4o' },
      stream: true,
      log: () => {},
    });
    console.log('  session created:', !!session);
    const r = await session.dispatchRequest();
    console.log('  request.result:', summarize(r && {
      url: r.url, method: r.method, endpoint_type: r.endpoint_type,
      upstream_stream_format: r.upstream_stream_format,
      downstream_stream_format: r.downstream_stream_format,
      retry_codes: r.retry_codes
    }));

    // Simulate upstream returning OpenAI chat completion JSON
    const upstreamBody = JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', model: 'gpt-4o', choices: [{ index: 0, message: { role: 'assistant', content: 'hi back' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
    const fakeHeaders = new Map([['content-type', 'application/json']]);
    const resp = await session.dispatchResponse({
      status: 200, headers: fakeHeaders,
      bodyBuffer: Buffer.from(upstreamBody, 'utf8'),
    });
    console.log('  response.result:', summarize(resp && {
      passthrough: resp.passthrough, status: resp.status, bodyText: resp.bodyText,
      body: resp.body
    }));
  }

  console.log('\n=== TEST 3: UNIVERSAL sandbox - shapes downstream into custom envelope ===');
  {
    const code = `module.exports = {
      universal: true,
      request: function(ctx) { return { body: ctx.req }; },
      response: function(ctx) {
        var j = ctx.upstream.bodyJson || {};
        return {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-sandbox-touched': '1' },
          body: { customEnvelope: true, originalRows: [], totalTokens: j.total_tokens || 0 }
        };
      }
    };`;
    const session = createSandboxSession(code, {
      req: {}, provider: { name: 'test' }, allowedHosts: [], log: () => {},
    });
    const resp = await session.dispatchResponse({
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      bodyBuffer: Buffer.from(JSON.stringify({ total_tokens: 123, choices: [{ message: { content: 'hi' } }] }), 'utf8'),
    });
    console.log('  response.result:', summarize(resp));
  }

  console.log('\n=== TEST 4: UNIVERSAL sandbox - uses allowlisted fetch to call endpoint X then shape ===');
  {
    const code = `module.exports = {
      universal: true,
      request: async function(ctx) {
        // simulate calling out to upstream to pre-fetch auth token before building body
        try {
          var r = await fetch('https://example.invalid/auth', { method: 'POST', body: { some: 'token' } });
          return {
            url: 'https://example.invalid/v1/anything',
            body: ctx.req,
            // mark stream intent
            stream: false
          };
        } catch (e) {
          // expected since example.invalid is invalid - we just want to test fetch infrastructure
          return { url: 'https://example.invalid/v1/anything', body: ctx.req, error_caught: e.message };
        }
      }
    };`;
    const session = createSandboxSession(code, {
      req: { ping: 1 },
      provider: { name: 'test', upstream_url: 'https://example.invalid' },
      allowedHosts: ['example.invalid'],
      perRequestTimeout: 5000,
      perFetchTimeout: 2000,
      maxChain: 3,
      log: () => {},
    });
    const r = await session.dispatchRequest();
    console.log('  request.result:', summarize(r && {
      url: r.url, body: r.body, error_caught: r.body && r.body.error_caught, ignored: !!r.__timedOut
    }));
  }

  console.log('\n=== TEST 5: UNIVERSAL sandbox - allowlist BLOCKS unallowed host ===');
  {
    const code = `module.exports = {
      universal: true,
      request: async function(ctx) {
        try {
          await fetch('https://not-allowed.example.com/x');
          return { body: ctx.req, called: true };
        } catch (e) {
          return { body: ctx.req, called: false, blocked_msg: e.message };
        }
      }
    };`;
    const session = createSandboxSession(code, {
      req: {},
      provider: { name: 'test', upstream_url: 'https://allowed.example.com' },
      allowedHosts: ['allowed.example.com'], // only this host
      perRequestTimeout: 5000,
      perFetchTimeout: 2000,
      log: () => {},
    });
    const r = await session.dispatchRequest();
    console.log('  r.called:', r && r.called, '| r.blocked_msg:', r && r.blocked_msg);
  }

  console.log('\n=== TEST 6: Sandbox fetch budget enforced (chained fetch count, aborts after max) ===');
  {
    const code = `module.exports = {
      universal: true,
      request: async function(ctx) {
        var successes = 0, lastErr = null;
        for (var i=0; i<20; i++) {
          try {
            await fetch('https://allowed.example.com/x');
            successes++;
          } catch (e) {
            lastErr = e.message;
            // First aborted-by-budget call should set lastErr
            // but the subsequent ones share 'already aborted'
          }
        }
        return { body: ctx.req, successes: successes, lastErr: lastErr };
      }
    };`;
    const session = createSandboxSession(code, {
      req: {},
      provider: { upstream_url: 'https://allowed.example.com' },
      allowedHosts: ['allowed.example.com'],
      perRequestTimeout: 10000,
      perFetchTimeout: 2000,
      maxChain: 3, // hard cap
      log: () => {},
    });
    const r = await session.dispatchRequest();
    console.log('  r.successes:', r && r.successes, '| r.lastErr:', r && r.lastErr);
    console.log('  (maxChain=3 -> if r.successes<=3 and r.lastErr mentions budget, budget enforced OK)');
  }

  process.exit(0);
}

run().catch(e => { console.error('FATAL', e); process.exit(1); });
