import { createSandboxSession } from '../src/sandboxRunner.js';

function summarize(o) {
  return JSON.stringify(o, (k, v) => v instanceof Buffer ? '[Buffer len=' + v.length + ']' : v, 2);
}

async function run() {
  console.log('=== TEST A: chain-poll - sandbox returns next_request 1x to simulate image-gen poll ===');
  {
    let responsePhaseInvocations = 0;
    const code = `module.exports = {
      universal: true,
      request: function (ctx) {
        return {
          url: 'https://example.invalid/v1/images/generations',
          method: 'POST',
          body: { prompt: ctx.req.prompt, model: ctx.context.stripped_model },
          endpoint_type: 'images',
          passthrough: false
        };
      },
      response: function (ctx) {
        // First call: upstream returns a job id; sandbox asks proxy to poll.
        // Second call: upstream returns the finished image; sandbox returns it shaped.
        var j = ctx.upstream.bodyJson || {};
        if (j.status === 'pending' && !ctx.data.__polledOnce) {
          ctx.data.__polledOnce = true;
          return { passthrough: false, next_request: { url: 'https://example.invalid/status/' + j.id, method: 'GET' }, body: null };
        }
        // Final hop
        return {
          passthrough: false,
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: { image_url: j.image_url || '<unknown>', model: ctx.context.stripped_model }
        };
      }
    };`;
    const session = createSandboxSession(code, {
      req: { prompt: 'cat' },
      provider: { upstream_url: 'https://example.invalid' },
      allowedHosts: ['example.invalid'],
      context: { path: '/v1/images/generations', method: 'POST', stripped_model: 'dall-e-3', original_model: 'opn:dall-e-3' },
      perRequestTimeout: 5000,
      maxChain: 5,
      log: () => {},
    });

    // First response phase call with a pending response.
    var upstream1 = JSON.stringify({ status: 'pending', id: 'job-1' });
    var r1 = await session.dispatchResponse({
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      bodyBuffer: Buffer.from(upstream1, 'utf8'),
    });
    console.log('  hop1 next_request:', r1 && r1.next_request ? r1.next_request.url : '(none)');
    responsePhaseInvocations++;

    // Second response phase call with a finished response.
    var upstream2 = JSON.stringify({ status: 'done', image_url: 'https://cdn.example/img1.png' });
    var r2 = await session.dispatchResponse({
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      bodyBuffer: Buffer.from(upstream2, 'utf8'),
    });
    console.log('  hop2 passthrough:', r2 && r2.passthrough, '| status:', r2 && r2.status, '| body:', summarize(r2 && r2.body));
    console.log('  total response-phase invocations:', responsePhaseInvocations + 1);
  }

  console.log('\n=== TEST B: default stream passthrough (no stream_chunk phase defined, frame is re-emitted) ===');
  {
    // We test splitStreamFrames + framing default via a direct call.
    // Import splitStreamFrames indirectly via session path - but it's a private function
    // in proxy.js. We at least verify that a sandbox with no stream_chunk dispatches
    // null gracefully (returns null) so the proxy falls into the default branch.
    const code = `module.exports = {
      universal: true,
      request: function (ctx) {
        return {
          url: 'https://upstream.invalid/v1/chat/completions',
          method: 'POST',
          body: ctx.req,
          upstream_stream_format: 'sse',
          downstream_stream_format: 'sse'
        };
      }
      // NO stream_chunk, NO response — proxy should default-passthrough everything
    };`;
    const session = createSandboxSession(code, {
      req: { model: 'opn:gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true },
      provider: { upstream_url: 'https://upstream.invalid' },
      allowedHosts: ['upstream.invalid'],
      stream: true,
      log: () => {},
    });
    const rr = await session.dispatchStreamChunk({
      chunkText: 'data: hello\n\n', chunkIndex: 0, isLast: false, upstreamEvent: '',
    });
    console.log('  stream_chunk dispatch (no phase defined):', summarize(rr));
    console.log('  hasPhase(stream_chunk):', session.hasPhase('stream_chunk'));
    console.log('  hasPhase(request):', session.hasPhase('request'));
    console.log('  hasPhase(response):', session.hasPhase('response'));
  }

  console.log('\n=== TEST C: endpoint_type preserved on request result ===');
  {
    const code = `module.exports = {
      universal: true,
      request: function (ctx) {
        return {
          url_path: '/v1/embeddings',
          method: 'POST',
          body: { input: ctx.req.input, model: ctx.context.stripped_model },
          endpoint_type: 'embeddings'
        };
      }
    };`;
    const session = createSandboxSession(code, {
      req: { input: 'hello' },
      provider: { upstream_url: 'https://embeddings.invalid' },
      context: { stripped_model: 'text-embedding-3-small' },
      log: () => {},
    });
    const r = await session.dispatchRequest();
    console.log('  endpoint_type:', r && r.endpoint_type);
    console.log('  url_path:', r && r.url_path);
    console.log('  body:', summarize(r && r.body));
  }

  process.exit(0);
}

run().catch(e => { console.error('FATAL', e); process.exit(1); });
