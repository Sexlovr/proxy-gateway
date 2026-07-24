# ⚡ Proxy Gateway

A **universal, provider-agnostic AI proxy** with a built-in management dashboard. Route any frontend — SillyTavern, JanitorAI, TypingMind, OpenWebUI, or anything with an API key field — through a single endpoint to any number of upstream AI providers.

Zero frontend modifications required. Zero provider logic hardcoded. Future-proof by design.

---

## Features

- **Wildcard Routing** — Any endpoint path, any HTTP method, passed through transparently
- **Prefix-Based Model Routing** — `opn:gpt-4o` routes to OpenAI, `gm:gemini-2.5-pro` routes to Gemini
- **Multi-Key Round Robin** — Automatic fallback when keys hit rate limits or expire
- **Thinking & Search Tags** — `[think=high]` and `[search=on]` in any message, works with every frontend
- **Sandbox JSON Templates** — Transform requests to match any upstream API format
- **Sandbox Code** — Full Node.js transform functions for power users
- **Stream Handling** — SSE passthrough, automatic stream-to-non-stream conversion
- **Provider Cloaking** — Password-protect and hide providers from the dashboard
- **Dashboard UI** — Add, edit, delete, cloak providers. Browse models. View live stats
- **Model Copy** — Click any model to copy its prefixed ID to clipboard
- **CORS Wide Open** — Use from anywhere, no origin restrictions
- **Persistent Storage** — JSON files in `/data` (Hugging Face Spaces compatible)

---

## Quick Deploy

### Hugging Face Spaces (Recommended)

1. Create a new **Docker** Space at [huggingface.co/spaces](https://huggingface.co/spaces)
2. Clone or upload the project files
3. Set **Secrets** in Space Settings:
   - `DELETE_PASSWORD` — admin password for deleting providers (default: `changeme`)
4. Attach a **Storage Bucket** mounted at `/data` for persistent config storage
5. Space builds and deploys automatically on port `7860`

### Railway / Render / Any VPS

```bash
git clone https://github.com/lolmaobruhhh/proxy-gateway.git
cd proxy-gateway
npm install
node server.js
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7860` | Server port |
| `DATA_DIR` | `/data` | Directory for persistent JSON storage |
| `DELETE_PASSWORD` | `changeme` | Admin password for destructive operations |

---

## How It Works

```
┌──────────────────┐         ┌──────────────┐         ┌─────────────────┐
│  SillyTavern /   │         │              │         │   OpenAI        │
│  JanitorAI /     │────────▶│    Proxy     │────────▶│   Gemini        │
│  Any Frontend    │◀────────│   Gateway    │◀────────│   Anthropic     │
│                  │         │              │         │   Any Upstream   │
└──────────────────┘         └──────────────┘         └─────────────────┘
```

1. Frontend sends a request with model `opn:gpt-4o`
2. Proxy strips the prefix `opn`, looks up the provider config
3. API keys are extracted from the `Authorization` header
4. Feature tags (`[think=high]`, `[search=on]`) are parsed and stripped from messages
5. Sandbox code runs first (if configured), then structured configs apply for unhandled features
6. Sandbox JSON template transforms the request structure (if configured)
7. Request is forwarded to upstream with the correct auth header
8. Response streams back to the frontend transparently

---

## Connecting Your Frontend

### API Key Format

In your frontend's **API Key** or **API Token** field, enter keys using this compound format:

```
opn=sk-key1,sk-key2;gm=AIza-key1,AIza-key2;cl=sk-ant-key1
```

| Symbol | Meaning |
|---|---|
| `opn` | Provider prefix (you set this when adding a provider) |
| `=` | Separates prefix from keys |
| `,` | Multiple keys for the same provider (round-robin + fallback) |
| `;` | Separates different providers |

The proxy reads the standard `Authorization: Bearer <value>` header, parses the compound format, and routes keys to the correct upstream. This means **zero frontend modifications** — every app that has an API key field works automatically.

### Model Name Format

Prefix every model name with the provider's short code:

```
opn:gpt-4o
gm:gemini-2.5-pro
cl:claude-sonnet-4-20250514
crmsn:cre/Qwen3-30B-A3B
```

### Endpoint

Point your frontend to:

```
https://your-proxy-url.hf.space/v1/chat/completions
```

Or literally any path — the proxy catches everything that isn't a dashboard route.

### Model List

```
GET https://your-proxy-url.hf.space/v1/models
```

Returns all models from all non-cloaked providers in standard OpenAI format with prefixes prepended.

---

## Dashboard Tabs

### + Add

Register a new upstream provider. Fields include:

| Field | Required | Description |
|---|---|---|
| **Prefix** | Yes | Unique short code (e.g., `opn`, `gm`, `cl`) |
| **Display Name** | No | Human-friendly name |
| **Upstream URL** | Yes | The real API base URL |
| **Auth Type** | No | `Bearer` (default), `x-api-key`, or custom header name |
| **Models Endpoint** | No | Path to fetch model list (default: `/v1/models`) |
| **Optional API Key** | No | Low-credit key for model list fetching only (stored server-side) |
| **Cloaking** | No | Hide this provider behind a password |
| **Think Config** | No | Structured JSON mapping for thinking/reasoning features |
| **Search Config** | No | Structured JSON mapping for search/grounding features |
| **Sandbox JSON** | No | Request template with placeholders for non-standard APIs |
| **Sandbox Code** | No | Node.js transform function for full control |

### Providers

View all registered providers. Click to see full details and edit history. Actions:

- **Edit** — Modify any field
- **Cloak** — Hide behind a password-protected lock
- **Delete** — Requires admin password

Cloaked providers appear in a separate section with password fields for reveal/uncloak.

### Models

Browse all fetched models across providers. Click any model row to copy the full prefixed model ID (e.g., `opn:gpt-4o`) to your clipboard. Filter by provider using the dropdown.

The **API Keys** field stores keys in your browser only (localStorage) for model list fetching.

### Stats

Live dashboard showing:
- Total requests processed
- Total errors
- Unique users (by IP)
- Currently active users
- Per-provider breakdowns

Stats auto-refresh every 10 seconds while the tab is active.

---

## Thinking & Search Tags

Control AI reasoning and web search from **any frontend** by putting tags in your system prompt or any message. The proxy detects them, strips them before forwarding, and applies the correct API parameters.

### Available Tags

```
[think=on]        Enable thinking (default budget)
[think=off]       Disable thinking
[think=high]      High reasoning budget
[think=medium]    Medium reasoning budget
[think=low]       Low reasoning budget
[think=32000]     Exact token budget

[search=on]       Enable web search / grounding
[search=off]      Disable web search
```

### Where To Put Them

Anywhere in any message. The system prompt is the most common place:

```
You are a helpful assistant. [think=high] [search=on]
```

The tags are stripped before the message reaches the upstream API. The model never sees them.

### How They Work (Priority Cascade)

```
1. Tags parsed from messages → stripped from content
2. Sandbox Code runs (if exists)
   → Returns which features it handled
3. Unhandled features → Think Config JSON applied
4. Unhandled features → Search Config JSON applied
5. Everything else → pure passthrough
```

This means a power user can write sandbox code that handles search but not thinking, and the structured Think Config will automatically handle the thinking part.

### Header Alternative

Apps that support custom headers can send features via:

```
x-proxy-features: think=high;search=on
```

Message tags override header values if both are present.

---

## Provider Configuration

### Basic Setup (No Config Needed)

For standard OpenAI-compatible APIs, just set the prefix and upstream URL. The proxy passes everything through as-is.

### Think Config (Structured JSON)

Maps the `[think=...]` tags to provider-specific API parameters:

```json
{
  "param_path": "thinking_config",
  "modes": {
    "on":     { "thinking_budget": 4096 },
    "off":    null,
    "low":    { "thinking_budget": 2048 },
    "medium": { "thinking_budget": 8192 },
    "high":   { "thinking_budget": 32000 }
  },
  "numeric_field": "thinking_budget"
}
```

- `param_path` — Where in the request body to inject the config
- `modes` — Maps tag values to API objects. `null` means delete the field
- `numeric_field` — Which field receives exact numeric values like `[think=32000]`

### Search Config (Structured JSON)

Maps the `[search=...]` tags to provider-specific tool injection:

```json
{
  "inject": {
    "on":  { "tools": [{ "google_search": {} }] },
    "off": null
  }
}
```

- `inject.on` — Object merged into the request body when search is enabled
- `inject.off` — `null` means do nothing (or strip search tools)

### Sandbox JSON (Request Template)

For non-standard APIs that expect a different request structure. Uses placeholders:

```json
{
  "url_path": "/v2/chat/completions",
  "headers": {
    "content-type": "application/json",
    "authorization": "Bearer {{KEY}}",
    "x-api-key": "{{KEY}}"
  },
  "body_template": {
    "model": "{{MODEL}}",
    "stream": true,
    "messages": "{{MESSAGES}}"
  },
  "forced_fields": {
    "stream": true
  }
}
```

| Placeholder | Replaced With |
|---|---|
| `{{KEY}}` | Current API key from round-robin |
| `{{MODEL}}` | Model name with prefix stripped |
| `{{MESSAGES}}` | Full messages array |
| `{{SYSTEM}}` | System message content (extracted) |
| `{{NON_SYSTEM_MESSAGES}}` | Messages array without system message |

`forced_fields` override whatever the frontend sends — useful for APIs that require specific values.

### Sandbox Code (Node.js Transform)

For maximum control, write a Node.js function that transforms the request. Runs in a sandboxed VM with a 5-second timeout.

```javascript
module.exports = function(req, features, provider) {
  var handled = {};

  // Handle thinking
  if (features.think) {
    req.generationConfig = req.generationConfig || {};
    if (features.think === 'off') {
      delete req.generationConfig.thinkingConfig;
    } else {
      var budget = 4096;
      if (features.think === 'low') budget = 1024;
      if (features.think === 'medium') budget = 8192;
      if (features.think === 'high') budget = 32000;
      if (!isNaN(Number(features.think))) budget = Number(features.think);
      req.generationConfig.thinkingConfig = { thinkingBudget: budget };
    }
    handled.think = true;
  }

  // Handle search
  if (features.search) {
    if (features.search === 'on') {
      req.tools = req.tools || [];
      var has = req.tools.some(function(t) { return !!t.googleSearch; });
      if (!has) req.tools.push({ googleSearch: {} });
    }
    handled.search = true;
  }

  // Force safety off
  req.safetySettings = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
  ];

  return { body: req, handled: handled };
};
```

**Function receives:**

| Parameter | Type | Description |
|---|---|---|
| `req` | Object | Full request body (mutable) |
| `features` | Object | Detected tags, e.g. `{ think: "high", search: "on" }` |
| `provider` | Object | Provider config (prefix, name, upstream_url, auth_type) |

**Must return:**

```javascript
{
  body: modifiedRequestBody,
  handled: {
    think: true,   // set if you handled thinking
    search: true   // set if you handled search
  }
}
```

Any feature NOT marked as handled will fall through to the structured config boxes. This lets you write sandbox code for just one feature while the structured configs handle the rest.

---

## Provider Cloaking

Hide sensitive providers from public view.

### How To Cloak

1. Go to **Providers** tab
2. Click **Cloak** on any provider
3. Enter a display name (shown in the cloaked list) and a password
4. Provider disappears from the main list, model list, and stats

### What Cloaking Hides

| Location | Visible? |
|---|---|
| Providers list | Hidden |
| Cloaked section | Shows display name only (no prefix, no URL) |
| `/v1/models` | Models hidden |
| `/api/models` | Models hidden |
| Stats tab | Aggregated under "cloaked" label |
| Proxy routing | **Still works** if you know the prefix |

### Reveal & Uncloak

- **Reveal** — Temporarily view full details (requires cloak password)
- **Uncloak** — Permanently unhide and move back to main list (requires cloak password)

---

## Key Fallback Behavior

When you provide multiple keys for a provider:

```
opn=sk-key1,sk-key2,sk-key3
```

The proxy uses them in round-robin order. If a key returns `401`, `403`, or `429`, it automatically tries the next key. If all keys fail, it returns an error with the last failure reason.

---

## Streaming

The proxy handles streaming transparently:

| Frontend Sends | Upstream Returns | Proxy Does |
|---|---|---|
| `stream: true` | SSE stream | Pipes stream directly |
| `stream: false` | JSON response | Returns JSON directly |
| `stream: false` | SSE stream (forced by sandbox) | Buffers all chunks, returns single JSON |

---

## API Reference

### Dashboard API

```
GET    /api/providers                         List visible providers
GET    /api/providers/cloaked                  List cloaked provider names
POST   /api/providers                         Create provider
GET    /api/providers/:prefix                 Get one provider
PUT    /api/providers/:prefix                 Update provider
DELETE /api/providers/:prefix                 Delete (requires admin password)
GET    /api/providers/:prefix/history         Edit history
POST   /api/providers/:prefix/cloak           Cloak a provider
POST   /api/providers/:prefix/uncloak         Uncloak (requires cloak password)
POST   /api/providers/cloaked/:prefix/reveal  View cloaked provider details
```

### Models API

```
GET    /api/models                            List cached models
POST   /api/models/fetch                      Fetch from all providers
POST   /api/models/fetch/:prefix              Fetch from one provider
GET    /v1/models                             OpenAI-compatible model list
```

### Stats API

```
GET    /api/stats                             Live statistics
```

### Health Check

```
GET    /health                                Server status and uptime
```

### Proxy

```
ANY    /*                                     Wildcard catch-all (non-dashboard routes)
```

---

## Project Structure

```
proxy-gateway/
├── Dockerfile
├── package.json
├── README.md
├── server.js              ← Entry point + inline dashboard
├── docs/
│   ├── BRIDGE-DESIGN.md  ← Bridge-v2 contract spec (the architecture doc)
│   └── SANDBOX.md        ← Sandbox authoring guide
├── public/               ← Dashboard SPA (vanilla JS, no build step)
│   ├── app.js
│   └── scripts/         ← Per-page modules (api, dashboard, providers, ...​)
├── sandboxes/           ← On-disk sandbox_code files (sandbox_file slug → here)
├── src/
│   ├── auth.js            ← Password verification
│   ├── bridgeProxy.js     ← Pure-bridge dispatcher (parses prefix, hands ctx to sandbox)
│   ├── defaultSandbox.js  ← Canonical OpenAI-compat passthrough (used when no sandbox_code set)
│   ├── keyManager.js      ← Compound key parser + round-robin
│   ├── kv.js              ← Per-provider file-backed KV store (ctx.store)
│   ├── log.js             ← Structured logger (ctx.log) + sandbox→proxy callbacks (ctx.proxy)
│   ├── models.js          ← Model fetching + aggregation
│   ├── providers.js       ← Provider CRUD + cloaking routes
│   ├── sandbox.js         ← Hot-reload loader (inline eval + .cjs fallback + cache)
│   ├── sandboxApi.js      ← /sandbox/test (exec sandbox with mock ctx) + /sandbox/files
│   ├── stats.js           ← Request tracking + stats API
│   └── storage.js         ← JSON file persistence (providers / stats / history)
└── data/                  ← Persistent storage (mounted volume on HF Space)
    ├── providers.json
    ├── stats.json
    ├── history.json
    └── kv/<prefix>/       ← Per-provider sandbox KV (openStore)
```

---

## Examples

### Adding OpenAI

- **Prefix:** `opn`
- **Upstream URL:** `https://api.openai.com`
- **Auth Type:** Bearer
- Everything else: defaults

### Adding Google Gemini with Thinking + Search

- **Prefix:** `gm`
- **Upstream URL:** `https://generativelanguage.googleapis.com`
- **Auth Type:** Bearer
- **Think Config:**
```json
{
  "param_path": "generationConfig.thinkingConfig",
  "modes": {
    "on": { "thinkingBudget": 4096 },
    "off": null,
    "low": { "thinkingBudget": 1024 },
    "medium": { "thinkingBudget": 8192 },
    "high": { "thinkingBudget": 32000 }
  },
  "numeric_field": "thinkingBudget"
}
```
- **Search Config:**
```json
{
  "inject": {
    "on": { "tools": [{ "googleSearch": {} }] },
    "off": null
  }
}
```

### Adding a Reverse-Engineered API (Sandbox JSON)

- **Prefix:** `kb`
- **Upstream URL:** `https://some-app.example.com`
- **Sandbox JSON:**
```json
{
  "url_path": "/v2/chat/completions",
  "headers": {
    "content-type": "application/json",
    "accept": "text/event-stream",
    "authorization": "Bearer {{KEY}}",
    "x-api-key": "{{KEY}}"
  },
  "body_template": {
    "model": "{{MODEL}}",
    "stream": true,
    "messages": "{{MESSAGES}}"
  },
  "forced_fields": {
    "stream": true
  }
}
```

### Using From SillyTavern

1. Set **API Type** to "Chat Completion (OpenAI)"
2. Set **Custom Endpoint** to `https://your-proxy-url.hf.space/v1`
3. Set **API Key** to `opn=sk-your-key-here`
4. Select model `opn:gpt-4o`
5. Optionally add `[think=high]` to your system prompt

---

## License

Do whatever you want with it. No restrictions.
