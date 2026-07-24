# Universal Sandbox Contract

The proxy gateway now supports a **universal** sandbox contract that lets you
fully own the request shape, the upstream execution, the response shape, and
the streaming framing — per provider, per endpoint. This is the reference for
that contract.

For backward compatibility, the original contract (single-phase
`module.exports = function(req, features, provider, context) { ... }`) still
works exactly as before. Universal mode is opt-in.

---

## When to use which

| Contract     | When to use it                                                            |
|--------------|---------------------------------------------------------------------------|
| Default      | Provider speaks OpenAI chat/completions natively. No code needed.           |
| Legacy       | You only need to rewrite the request and pick a response parser.           |
| **Universal**| You need to call non-OpenAI endpoints (embeddings, images, audio, custom shapes), send multipart uploads, poll async jobs, mix stream formats (SSE↔NDJSON), or fully own the downstream JSON shape. |

---

## Universal export shape

```js
module.exports = {
  universal: true,

  // OPTIONAL: edit outgoing request before upstream call
  request: function (ctx) { ... },

  // OPTIONAL: shape downstream payload after upstream returns (non-streaming)
  response: function (ctx) { ... },

  // OPTIONAL: per chunk during streaming
  stream_chunk: function (ctx) { ... },

  // OPTIONAL: called when stream ends
  stream_end: function (ctx) { ... },
};
```

Or as a single dispatched function:

```js
module.exports = function (ctx) {
  if (ctx.phase === 'request') return { ... };
  if (ctx.phase === 'response') return { ... };
  if (ctx.phase === 'stream_chunk') return { ... };
  if (ctx.phase === 'stream_end') return { /* nothing */ };
};
```

`ctx.phase` is always set by the proxy when it dispatches.

---

## ctx

| Phase         | Available fields                                                            |
|---------------|-----------------------------------------------------------------------------|
| `request`     | `ctx = { phase, req, features, provider, context, stream, data }`            |
| `response`    | adds `ctx.upstream = { status, headers, bodyText, bodyJson?, bodyBuffer }`, `ctx.isStream=false` |
| `stream_chunk`| adds `ctx.chunkText, ctx.chunkBuffer, ctx.chunkIndex, ctx.isLast, ctx.upstreamEvent`, `ctx.isStream=true` |
| `stream_end`  | adds `ctx.isLast=true`, `ctx.isStream=true`                                   |

`ctx.data` is a mutable scratch object that survives across phases for a
single request. Use it to carry state from `request` to `response` to
`stream_chunk`.

`ctx.context` has `{ path, method, original_model, stripped_model }` reflecting
the original request from the client. Always use `ctx.context.stripped_model`
for the model name (the proxy prefix has already been stripped).

`ctx.provider` is the full provider object minus secret keys (so sandbox code
cannot leak the API key). The proxy injects `{{KEY}}` into URL/headers/body
after the request phase returns.

---

## Sandbox-provided globals

Inside the sandbox, these are available:

| Global | Notes |
|---|---|
| `fetch` | Allowlisted outbound HTTP, see below |
| `JSON`, `Array`, `Object`, `String`, `Number`, `Math`, `parseInt`, ... | Standard JS builtins |
| `Date`, `RegExp`, `Error`, `Boolean`, `Map`, `Set`, `WeakMap`, `WeakSet`, `Symbol`, `Promise` | |
| `encodeURIComponent`, `decodeURIComponent`, `encodeURI`, `decodeURI` | |
| `URL`, `URLSearchParams` | |
| `Buffer` (SafeBuffer) | `.from`, `.alloc`, `.allocUnsafe`, `.concat`, `.isBuffer`, `.byteLength` — encoding only |
| `TextEncoder`, `TextDecoder` | |
| `btoa`, `atob` | base64 helpers |
| `crypto.randomUUID()` | |
| `setTimeout`, `clearTimeout` | real timers; capped at 30ms wait per call |
| `console.log/.error/.warn/.info` | captured into trace, surfaced via `x-sandbox-error` |

**Not exposed**: `process`, `require`, `import`, `eval`, `Function`, `fs`,
`child_process`, `net`, `setInterval`, `import.meta`.

---

## request phase return shape

```js
return {
  url: 'https://api.example.com/v1/embeddings',
  // OR
  url_path: '/v1/embeddings',   // appended to provider.upstream_url

  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-custom': 'value-{{KEY}}' },
  body: { ...any JSON shape... },

  // For raw binary uploads (overrides body when set)
  raw_body_buffer: Buffer.from('...'),

  // For multipart/form-data (file uploads, audio/transcriptions, etc.)
  is_multipart: true,
  form: [
    { name: 'file', filename: 'audio.mp3', contentType: 'audio/mpeg', body: Buffer.from(bytes) },
    { name: 'model', value: 'whisper-1' }
  ],

  stream: false,                     // override client stream intent

  upstream_stream_format:   'sse' | 'ndjson' | 'json_lines' | 'chunked_json' | 'raw' | 'none',
  downstream_stream_format: same set + 'openai_chat_sse',

  downstream_content_type: 'text/event-stream',  // (optional) override Content-Type for the streamed downstream response. Default derived from downstream_stream_format (e.g. 'sse' -> 'text/event-stream', 'raw' -> 'application/octet-stream'). Useful when the upstream emits native SSE but you pick 'raw' for byte-perfect passthrough.
  trail_done: false,                            // (optional) suppress the OpenAI-style 'data: [DONE]\n\n' trailer that the proxy appends at stream end. Default: emit when downstream_stream_format is 'sse' or 'openai_chat_sse'. Set to false for native Anthropic / custom SSE streams that own their own terminator.

  retry_codes: [401, 403, 429, 500, 502, 503], // FULLY replaces default set
  retry_codes_mode: 'replace' | 'merge',          // 'replace' is default in v2

  timeout_ms: 60000,

  handled: { think: true, search: true },         // tell proxy you took care of these features
  endpoint_type: 'chat' | 'embeddings' | 'images' | 'audio' | 'responses' | 'moderations' | 'files' | 'raw',

  hijack: true,        // sandbox fully owns downstream; proxy stops
  passthrough: true,   // response phase forwards upstream untouched

  next_request: { ... },  // not yet implemented (chain-poll in v2)

  any_extra_field: 'value' // arbitrary metadata preserved
};
```

`endpoint_type` is informational (used for stats). It does NOT changepping
output shape — the response phase does that.

---

## response phase return shape

```js
return {
  // Sandbox shapes downstream
  status: 200,
  headers: { 'content-type': '...' },
  body: { ...any JSON shape... }
  // OR string OR Buffer
};

// OR — let proxy passthrough upstream as-is:
return { passthrough: true };
```

If a sandbox doesn't define a `response` phase, the proxy defaults to
passthrough. No more forced `chat.completion` envelope.

---

## stream_chunk phase return shape

```js
return {
  downstream_chunk: 'data: ...\n\n', // string OR Buffer OR object (auto-stringified)
  done: false                         // true ends the downstream stream
};
```

If `downstream_chunk` is `null`, that chunk is silently dropped.

If `done: true`, the proxy ends the downstream stream immediately (after also
calling `stream_end`).

---

## Sandbox fetch

`fetch(url, init)` inside the sandbox:

- **Host allowlist**: by default only the provider's `upstream_url` host. Add
  more via provider `allowed_hosts: ["foo.example.com", ".bar.com"]`
  (leading-dot means any subdomain of `bar.com`).
- **Per-request budget**: `maxChain` total fetches per user request (default 10).
  Each fetch has a timeout (default 30s).
- **Concurrency**: 5 in-flight per request.
- **Bytes**: 50 MB total per request.
- **Method**: any.
- **Body**: string or JSON-serialisable object.
- **Response methods**: `.status`, `.ok`, `.headers`, `.url`, `.text()`,
  `.json()`, `.arrayBuffer()`, `.getReader()` (for streaming reads).

Any violation aborts the sandbox and surfaces in `r.lastErr` in the request
result.

---

## Sandbox files

Instead of pasting code into the provider's `sandbox_code` field, you can
create `./sandboxes/<name>.js` in the proxy install dir and reference it via
`provider.sandbox_file: "<name>.js"`. The file is hot-reloaded on save
(500ms debounce), no restart needed. Reload errors surface as
`x-sandbox-error` header on the next request.

---

## Test endpoints

Iterate without making real upstream calls:

```
POST /sandbox/test
{
  "code": "module.exports = { universal: true, request: ... };",
  "req": { "model": "opn:gpt-4o", "messages": [...] },
  "stream": false,
  "stripped_model": "gpt-4o"
}

→ returns: { "request": <normalized result>, "trace": [...] }
```

```
POST /sandbox/test_response
{
  "code": "module.exports = { universal: true, response: ... };",
  "upstreamStatus": 200,
  "upstreamContentType": "application/json",
  "upstreamBody": "{\"...\":\"...\"}"
}

→ returns: { "response": <downstream payload sandbox would emit>, "trace": [...] }
```

Also:

```
GET  /sandbox/files            # list loaded sandbox files
GET  /sandbox/file/:name       # return cached source of a sandbox file
```

---

## Examples

### OpenAI-style chat (passthrough)
```js
module.exports = {
  universal: true,
  request: function (ctx) {
    return {
      url_path: '/v1/chat/completions',
      method: 'POST',
      body: ctx.req,
      endpoint_type: 'chat',
      upstream_stream_format: 'sse',
      downstream_stream_format: 'openai_chat_sse',
      retry_codes: [401, 403, 429]
    };
  },
  response: function (ctx) {
    return { passthrough: true };
  },
  stream_chunk: function (ctx) {
    return { downstream_chunk: ctx.chunkText };
  }
};
```

### Embeddings (custom downstream shape)
```js
module.exports = {
  universal: true,
  request: function (ctx) {
    return {
      url_path: '/v1/embeddings',
      method: 'POST',
      body: {
        input: ctx.req.input || ctx.req.messages,
        model: ctx.context.stripped_model
      },
      endpoint_type: 'embeddings',
      retry_codes: [401, 403, 429]
    };
  },
  response: function (ctx) {
    // Forward upstream's embeddings response untouched
    return { passthrough: true };
  }
};
```

### Image generation (poll async job then return)
```js
module.exports = {
  universal: true,
  request: async function (ctx) {
    // Submit generation
    var r = await fetch('https://api.example.com/v1/images/generations', {
      method: 'POST',
      body: { prompt: ctx.req.prompt, model: ctx.context.stripped_model }
    });
    var j = await r.json();
    ctx.data.jobId = j.id;
    return { hijack: true };  // we'll fully own downstream below
  },
  // NOTE: hijack short-circuits the normal flow. To do async polling,
  // do it inside request and return response via set on a waited Promise.
  // The proxy is a synchronous flow after request; for polling, do the whole
  // dance inside request and call ctx.expressRes (currently NOT exposed in v2)
  // OR use the response phase pattern below.
  //
  // For polling without hijack, see the next example pattern.
};
```

### Gemini streaming (non-OpenAI upstream → OpenAI SSE downstream)
```js
module.exports = {
  universal: true,
  request: function (ctx) {
    var model = ctx.context.stripped_model;
    return {
      url: 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':streamGenerateContent?alt=sse',
      method: 'POST',
      body: {
        contents: ctx.req.messages.map(function(m) {
          return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
        })
      },
      endpoint_type: 'chat',
      upstream_stream_format: 'sse',
      downstream_stream_format: 'openai_chat_sse'
    };
  },
  stream_chunk: function (ctx) {
    // Each upstream SSE frame is a Gemini JSON chunk
    try {
      var g = JSON.parse(ctx.chunkText);
      var parts = g.candidates && g.candidates[0] && g.candidates[0].content && g.candidates[0].content.parts;
      if (!parts) return null;
      var text = parts.map(function(p) { return p.text || ''; }).join('');
      if (!text) return null;
      var out = { id: 'chatcmpl-' + Date.now(), object: 'chat.completion.chunk', model: ctx.context.original_model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
      return { downstream_chunk: 'data: ' + JSON.stringify(out) + '\n\n' };
    } catch (e) {
      return null;
    }
  }
};
```

### Audio transcription (multipart upload)
```js
module.exports = {
  universal: true,
  request: function (ctx) {
    return {
      url_path: '/v1/audio/transcriptions',
      method: 'POST',
      is_multipart: true,
      form: [
        { name: 'file', filename: 'audio.mp3', contentType: 'audio/mpeg',
          body: Buffer.from(ctx.req.audio_base64, 'base64') },
        { name: 'model', value: ctx.context.stripped_model }
      ],
      endpoint_type: 'audio',
      retry_codes: [401, 403, 429]
    };
  },
  response: function (ctx) {
    return { passthrough: true };
  }
};
```

### Byte-perfect passthrough (provider already speaks the downstream format natively)

When the upstream already emits exactly the bytes the downstream client expects — no
translation, no reframing, no injected trailers. Use `upstream_stream_format: 'raw'` +
`downstream_stream_format: 'raw'` so the proxy streams bytes through verbatim, then pair
with `downstream_content_type` to fix the Content-Type (default for 'raw' is
`application/octet-stream`, which breaks SSE clients), and `trail_done: false` to suppress
the `'data: [DONE]\n\n'` trailer that the proxy would inject for `sse`/`openai_chat_sse`.
You can still route per-path and rewrite the body in the `request` phase.

```js
module.exports = {
  universal: true,
  request: function (ctx) {
    // Route inbound /v1/messages -> upstream /v1/messages verbatim
    var intent = /\/v1\/messages/.test(ctx.context.path || '') ? 'messages' : 'chat';
    return {
      url_path: intent === 'messages' ? '/v1/messages' : '/v1/chat/completions',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer {{KEY}}' },
      body: ctx.req,
      endpoint_type: intent === 'messages' ? 'raw' : 'chat',
      upstream_stream_format: 'raw',     // don't parse upstream SSE into frames
      downstream_stream_format: 'raw',   // don't re-frame downstream — pass bytes through
      downstream_content_type: 'text/event-stream',  // override default octet-stream
      trail_done: false,                 // upstream emits its own terminator (e.g. event: message_stop)
      retry_codes: [401, 403, 429, 500, 502, 503]
    };
  }
  // No response / stream_chunk phases: response() defaults to passthrough, stream_chunk
  // to raw re-frame which is a no-op when both formats are 'raw'.
};
```

---

## Backward compatibility

Providers without `sandbox_code` and `sandbox_file` use the default OpenAI
chat/completions passthrough — same as before.

Providers whose `sandbox_code` uses the legacy signature
`module.exports = function(req, features, provider, context) { ... }` with
the legacy return shape `{ url, body, response_format, ... }` continue to work
unchanged, including the hardcoded `chat.completion` output shaping.

Only providers whose sandbox code declares `universal: true` (or returns phase
functions) take the new universal path.
