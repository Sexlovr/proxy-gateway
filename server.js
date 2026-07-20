import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';

import { initStorage, getProvider } from './src/storage.js';
import { providersRouter } from './src/providers.js';
import { modelsRouter, getAggregatedModels } from './src/models.js';
import { statsRouter, trackRequest } from './src/stats.js';
import { handleProxy } from './src/proxy.js';
import { initSandboxLoader, getSandboxCode, listSandboxFiles, getSandboxDir } from './src/sandboxLoader.js';
import { createSandboxSession } from './src/sandboxRunner.js';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var PORT = process.env.PORT || 7860;
var app = express();

app.use(cors({ origin: '*', methods: '*', allowedHeaders: '*', exposedHeaders: '*', credentials: false }));

app.get('/health', function(_req, res) { res.json({ status: 'ok', uptime: process.uptime() }); });

var css = [
  ':root{--bg:#0a0a0f;--surface:rgba(255,255,255,0.04);--surface-hover:rgba(255,255,255,0.07);--border:rgba(255,255,255,0.08);--text:#e4e4e7;--text-dim:#71717a;--accent:#818cf8;--accent-glow:rgba(129,140,248,0.15);--danger:#f87171;--success:#34d399;--warning:#fbbf24;--radius:12px;--font:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--mono:"Courier New",monospace}',
  '*{box-sizing:border-box;margin:0;padding:0}',
  'body{font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh;line-height:1.6}',
  '.app{max-width:960px;margin:0 auto;padding:1rem}',
  '.header{display:flex;align-items:center;justify-content:space-between;padding:1rem 0;border-bottom:1px solid var(--border);margin-bottom:2rem;flex-wrap:wrap;gap:1rem}',
  '.logo{font-size:1.4rem;font-weight:700;color:var(--accent)}',
  '.tabs{display:flex;gap:.25rem;background:var(--surface);border-radius:var(--radius);padding:4px}',
  '.tab{background:none;border:none;color:var(--text-dim);padding:.5rem 1rem;border-radius:8px;cursor:pointer;font-size:.875rem;font-weight:500;transition:all .2s}',
  '.tab:hover{color:var(--text);background:var(--surface-hover)}',
  '.tab.active{color:var(--text);background:var(--accent-glow);box-shadow:0 0 0 1px var(--accent)}',
  '.tab-panel{display:none}.tab-panel.active{display:block;animation:fadeIn .25s ease}',
  '@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}',
  '.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1.5rem;margin-bottom:1rem}',
  '.card h2{font-size:1.25rem;margin-bottom:1.5rem;font-weight:600}',
  '.card h3{font-size:1rem;font-weight:600;color:var(--text-dim)}',
  '.form-row{display:grid;grid-template-columns:1fr 1fr;gap:1rem}',
  '.form-group{margin-bottom:1rem;position:relative}',
  '.form-group label{display:block;font-size:.8rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim);margin-bottom:.35rem}',
  '.hint{font-weight:400;text-transform:none;letter-spacing:0;opacity:.6;font-size:.75rem}',
  '.field-note{font-size:.75rem;color:var(--warning);margin-top:.35rem;opacity:.8}',
  'input[type="text"],input[type="url"],input[type="password"],select,textarea{width:100%;background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:8px;padding:.6rem .8rem;color:var(--text);font-size:.9rem;font-family:var(--font);transition:border-color .2s;outline:none}',
  'input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow)}',
  'textarea{font-family:var(--mono);font-size:.8rem;resize:vertical;line-height:1.5}',
  'select{cursor:pointer}',
  '.btn{display:inline-flex;align-items:center;gap:.4rem;padding:.6rem 1.2rem;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font-size:.875rem;font-weight:500;cursor:pointer;transition:all .2s}',
  '.btn:hover{background:var(--surface-hover)}',
  '.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}',
  '.btn.primary:hover{opacity:.9}',
  '.btn.danger{background:rgba(248,113,113,.15);border-color:var(--danger);color:var(--danger)}',
  '.btn.danger:hover{background:rgba(248,113,113,.25)}',
  '.btn.small{padding:.35rem .75rem;font-size:.8rem}',
  '.providers-grid{display:grid;gap:.75rem}',
  '.provider-card{display:flex;align-items:center;justify-content:space-between;padding:1rem 1.25rem;background:rgba(0,0,0,.2);border:1px solid var(--border);border-radius:10px;cursor:pointer;transition:all .2s}',
  '.provider-card:hover{border-color:var(--accent);background:var(--accent-glow)}',
  '.provider-info h4{font-size:1rem;font-weight:600}',
  '.prefix-badge{display:inline-block;background:var(--accent-glow);color:var(--accent);padding:.1rem .5rem;border-radius:4px;font-size:.75rem;font-family:var(--mono);margin-left:.5rem}',
  '.url-text{font-size:.8rem;color:var(--text-dim);margin-top:.2rem}',
  '.provider-actions{display:flex;gap:.5rem;flex-wrap:wrap}',
  '.modal{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center}',
  '.modal.hidden{display:none}',
  '.modal-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px)}',
  '.modal-content{position:relative;max-width:700px;width:90%;max-height:85vh;overflow-y:auto;z-index:1}',
  '.modal-content.small{max-width:400px}',
  '.modal-close{position:absolute;top:1rem;right:1rem;background:none;border:none;color:var(--text-dim);font-size:1.5rem;cursor:pointer}',
  '.modal-close:hover{color:var(--text)}',
  '.modal-actions{display:flex;gap:.5rem;margin-top:1rem}',
  '.models-toolbar{display:flex;gap:1rem;align-items:center;flex-wrap:wrap}',
  '.models-toolbar select{width:auto;min-width:180px}',
  '.models-grid{display:grid;gap:.4rem}',
  '.model-row{display:flex;align-items:center;gap:.75rem;padding:.5rem .75rem;background:rgba(0,0,0,.15);border-radius:6px;font-family:var(--mono);font-size:.8rem;cursor:pointer;transition:background .2s}',
  '.model-row:hover{background:rgba(129,140,248,.1)}',
  '.model-row .prefix{color:var(--accent);font-weight:600;min-width:40px}',
  '.model-row .model-id{color:var(--text);flex:1}',
  '.model-row .copy-icon{color:var(--text-dim);font-size:.75rem}',
  '.search-box{margin:1rem 0;position:relative}',
  '.model-counts{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0}',
  '.count-badge{display:inline-flex;align-items:center;gap:.35rem;background:rgba(0,0,0,.2);border:1px solid var(--border);border-radius:6px;padding:.3rem .7rem;font-size:.75rem}',
  '.count-badge .count-label{color:var(--text-dim)}',
  '.count-badge .count-num{color:var(--accent);font-weight:700;font-family:var(--mono)}',
  '.count-badge.total{border-color:var(--accent);background:var(--accent-glow)}',
  '.count-badge.total .count-label{color:var(--text)}',
  '.stats-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem}',
  '.stat-card{background:rgba(0,0,0,.2);border:1px solid var(--border);border-radius:10px;padding:1.25rem;text-align:center}',
  '.stat-card .stat-value{font-size:2rem;font-weight:700;color:var(--accent);line-height:1}',
  '.stat-card .stat-label{font-size:.75rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em;margin-top:.4rem}',
  '.stat-provider-row{display:flex;align-items:center;justify-content:space-between;padding:.75rem 1rem;background:rgba(0,0,0,.15);border-radius:8px;margin-top:.5rem}',
  '.stat-provider-row .sp-name{font-weight:600;font-family:var(--mono);color:var(--accent)}',
  '.stat-provider-row .sp-stats{display:flex;gap:1.5rem;font-size:.8rem;color:var(--text-dim)}',
  '.stat-provider-row .sp-stats span{color:var(--text);font-weight:600}',
  '.detail-section{margin-bottom:1.25rem}',
  '.detail-section .detail-label{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim);margin-bottom:.25rem}',
  '.detail-section .detail-value{font-family:var(--mono);font-size:.85rem;background:rgba(0,0,0,.3);padding:.5rem .75rem;border-radius:6px;word-break:break-all}',
  '.detail-section pre{font-family:var(--mono);font-size:.8rem;background:rgba(0,0,0,.3);padding:.75rem;border-radius:6px;overflow-x:auto;white-space:pre-wrap}',
  '.history-entry{padding:.5rem 0;border-bottom:1px solid var(--border);font-size:.8rem}',
  '.history-entry:last-child{border-bottom:none}',
  '.history-entry .he-time{color:var(--text-dim);font-family:var(--mono);font-size:.7rem}',
  '.history-entry .he-action{color:var(--accent);font-weight:600}',
  '#toasts{position:fixed;bottom:1.5rem;right:1.5rem;display:flex;flex-direction:column;gap:.5rem;z-index:9999}',
  '.toast{padding:.75rem 1.25rem;border-radius:8px;font-size:.85rem;font-weight:500;animation:slideIn .3s ease;max-width:360px}',
  '.toast.success{background:rgba(52,211,153,.15);border:1px solid var(--success);color:var(--success)}',
  '.toast.error{background:rgba(248,113,113,.15);border:1px solid var(--danger);color:var(--danger)}',
  '.toast.info{background:var(--accent-glow);border:1px solid var(--accent);color:var(--accent)}',
  '@keyframes slideIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}',
  '.section-divider{font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:var(--text-dim);margin:1.5rem 0 .75rem;padding-bottom:.5rem;border-bottom:1px solid var(--border)}',
  '.presets{display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:1.5rem}',
  '.preset-btn{padding:.45rem .9rem;border-radius:8px;font-size:.8rem;font-weight:600;border:1px solid var(--border);background:rgba(0,0,0,.2);color:var(--text-dim);cursor:pointer;transition:all .2s}',
  '.preset-btn:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-glow)}',
  '.preset-btn .preset-icon{margin-right:.35rem}',
  '.checkbox-row{display:flex;align-items:center;gap:.5rem;margin-bottom:1rem}',
  '.checkbox-row input[type="checkbox"]{width:auto;margin:0}',
  '.checkbox-row label{margin:0;text-transform:none;font-size:.85rem;color:var(--text)}',
  '.cloak-card{background:rgba(0,0,0,.2);border:1px solid var(--border);border-radius:10px;padding:1rem 1.25rem;margin-bottom:.5rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.5rem}',
  '.cloak-card .cloak-name{font-weight:600;color:var(--warning)}',
  '.cloak-card .cloak-actions{display:flex;gap:.5rem;align-items:center}',
  '.cloak-card input{width:140px}',
  '.help-content{font-size:.85rem;line-height:1.7}',
  '.help-content pre{margin:.75rem 0;font-size:.72rem;max-height:250px;overflow-y:auto}',
  '.help-content code{background:rgba(0,0,0,.3);padding:.1rem .3rem;border-radius:3px;font-size:.8rem}',
  '.pw-toggle{position:absolute;right:10px;top:32px;background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:.85rem;outline:none}',
  '.copy-box{position:relative;border:1px solid var(--accent);border-radius:8px;padding:1rem;margin:1rem 0;background:rgba(0,0,0,.3)}',
  '.copy-box pre{margin:0;max-height:300px;overflow-y:auto}',
  '.copy-box-btn{position:absolute;top:8px;right:8px;padding:.25rem .5rem;font-size:.7rem;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer}',
  '.copy-box-btn:hover{opacity:.8}',
  '@media(max-width:640px){.form-row{grid-template-columns:1fr}.header{flex-direction:column;align-items:flex-start}.stats-cards{grid-template-columns:1fr 1fr}.model-counts{gap:.35rem}.count-badge{font-size:.7rem;padding:.2rem .5rem}.cloak-card{flex-direction:column;align-items:flex-start}.cloak-card .cloak-actions{width:100%;justify-content:space-between}.cloak-card input{width:100%;flex:1}}',
].join('\n');
var htmlBody = [
  '<div class="app">',
  '<header class="header">',
  '<div class="logo">&#9889; Proxy Gateway</div>',
  '<nav class="tabs">',
  '<button class="tab active" data-tab="add">+ Add</button>',
  '<button class="tab" data-tab="providers">Providers</button>',
  '<button class="tab" data-tab="models">Models</button>',
  '<button class="tab" data-tab="stats">Stats</button>',
  '</nav>',
  '</header>',
  '<main class="content">',
  '<section id="tab-add" class="tab-panel active"><div class="card">',
  '<h2>Add New Provider</h2>',
  '<p style="color:var(--text-dim);font-size:.85rem;margin-bottom:1rem">Quick start: click a preset to auto-fill, then just save.</p>',
  '<div class="presets"><button type="button" class="preset-btn" data-preset="openai"><span class="preset-icon">🟢</span>OpenAI</button><button type="button" class="preset-btn" data-preset="gemini"><span class="preset-icon">🔵</span>Gemini</button><button type="button" class="preset-btn" data-preset="anthropic"><span class="preset-icon">🟠</span>Anthropic</button><button type="button" class="preset-btn" data-preset="openrouter"><span class="preset-icon">🟣</span>OpenRouter</button><button type="button" class="preset-btn" data-preset="atxp"><span class="preset-icon">⚡</span>ATXP.ai</button></div>',
  '<form id="add-form" autocomplete="off">',
  '<div class="form-row"><div class="form-group"><label>Prefix <span class="hint">unique short code</span></label><input type="text" id="add-prefix" placeholder="opn" required maxlength="10"></div><div class="form-group"><label>Display Name</label><input type="text" id="add-name" placeholder="OpenAI"></div></div>',
  '<div class="form-group"><label>Upstream URL</label><input type="url" id="add-url" placeholder="https://api.openai.com" required></div>',
  '<div class="form-row"><div class="form-group"><label>Auth Type</label><select id="add-auth-type"><option value="bearer">Bearer</option><option value="x-api-key">x-api-key</option><option value="custom">Custom</option></select></div><div class="form-group" id="custom-header-group" style="display:none"><label>Custom Header</label><input type="text" id="add-auth-header" placeholder="x-custom-key"></div></div>',
  '<div class="form-group"><label>Models Endpoint <span class="hint">default: /v1/models</span></label><input type="text" id="add-models-endpoint" placeholder="/v1/models"></div>',
  '<div class="form-group"><label>Optional API Key <span class="hint">for model list loading only</span></label><input type="text" id="add-optional-key" placeholder="sk-..."></div>',
  '<div class="section-divider">Cloaking</div>',
  '<div class="checkbox-row"><input type="checkbox" id="add-cloaked"><label for="add-cloaked">Cloak this provider</label></div>',
  '<div id="cloak-fields" style="display:none"><div class="form-row"><div class="form-group"><label>Cloak Display Name</label><input type="text" id="add-cloak-name" placeholder="MySecret"></div><div class="form-group"><label>Cloak Password</label><input type="password" id="add-cloak-password" placeholder="password to reveal"><button type="button" class="pw-toggle" onclick="toggleAddPassword(this)">Show</button></div></div></div>',
  '<div class="section-divider">Thinking Config <span class="hint">optional</span></div>',
  '<div class="form-group"><textarea id="add-think-config" rows="6"></textarea></div>',
  '<div class="section-divider">Search Config <span class="hint">optional</span></div>',
  '<div class="form-group"><textarea id="add-search-config" rows="4"></textarea></div>',
  '<div class="section-divider">Sandbox JSON <span class="hint">request template</span></div>',
  '<div class="form-group"><textarea id="add-sandbox" rows="8"></textarea></div>',
  '<div class="section-divider">Sandbox Code <span class="hint">advanced</span> <button type="button" class="btn small" id="help-btn" style="margin-left:.5rem">? Help</button></div>',
  '<div class="form-group"><textarea id="add-sandbox-code" rows="10"></textarea></div>',
  '<button type="submit" class="btn primary">Save Provider</button>',
  '</form></div></section>',
  '<section id="tab-providers" class="tab-panel"><div class="card"><h2>Registered Providers</h2><div class="search-box"><input type="text" id="providers-search" placeholder="Search providers..." autocomplete="off"></div><div id="providers-list" class="providers-grid"><p style="color:#71717a">Loading...</p></div></div><div class="card" id="cloaked-section" style="display:none"><h3>&#128274; Cloaked Providers</h3><div id="cloaked-list" style="margin-top:.75rem"></div></div><div id="provider-modal" class="modal hidden"><div class="modal-backdrop"></div><div class="modal-content card"><button class="modal-close">&times;</button><div id="provider-detail"></div></div></div><div id="delete-modal" class="modal hidden"><div class="modal-backdrop"></div><div class="modal-content card small"><h3>Confirm Delete</h3><p>Enter admin password.</p><input type="password" id="delete-password" placeholder="Password"><div class="modal-actions"><button class="btn danger" id="delete-confirm">Delete</button><button class="btn" id="delete-cancel">Cancel</button></div></div></div></section>',
  '<section id="tab-models" class="tab-panel"><div class="card"><h2>Models</h2><div class="models-toolbar"><select id="models-provider-filter"><option value="all">All Providers</option></select><button class="btn" id="fetch-models-btn">Fetch Models</button></div><div id="model-counts" class="model-counts"></div><div class="search-box"><input type="text" id="models-search" placeholder="Search models..." autocomplete="off"></div><div class="form-group" style="margin-top:.5rem"><label>API Keys <span class="hint">browser-only</span></label><input type="text" id="models-keys" placeholder="opn=sk-abc;gm=AIza-xyz"><button class="btn small" id="save-keys-btn" style="margin-top:.5rem">Save to Browser</button></div><div id="models-list" class="models-grid" style="margin-top:1rem"><p style="color:#71717a">No models loaded yet.</p></div></div></section>',
  '<section id="tab-stats" class="tab-panel"><div class="card"><h2>Dashboard</h2><div class="stats-cards" id="stats-overview"><p style="color:#71717a">Loading...</p></div><h3 style="margin-top:2rem">Per Provider</h3><div id="stats-providers"></div></div></section>',
  '</main>',

  // ── HELP MODAL WITH MASTER PROMPT ──
  '<div id="help-modal" class="modal hidden"><div class="modal-backdrop"></div><div class="modal-content card" style="max-width:800px"><button class="modal-close">&times;</button>',
  '<h2>Sandbox Code — Complete Reference</h2><div class="help-content">',

  '<p><strong>1. Function Signature</strong></p>',
  '<pre>module.exports = function(req, features, provider, context) {\n  var handled = {};\n  return {\n    body: req,\n    url: "",\n    headers: {},\n    method: "POST",\n    response_format: "openai",\n    handled: handled\n  };\n};</pre>',

  '<p><strong>2. Parameters</strong></p>',
  '<p><code>req</code> — OpenAI-format request body (mutable). Contains model, messages[], stream, temperature, max_tokens, etc.</p>',
  '<p><code>features</code> — All [key=value] tags stripped from messages. e.g. {think:"high", search:"on", safety:"off", custom:"whatever"}</p>',
  '<p><code>provider</code> — {prefix, name, upstream_url, auth_type, auth_header, models_endpoint}</p>',
  '<p><code>context</code> — {path, method, original_model, stripped_model}. <strong>ALWAYS use context.stripped_model for the model name.</strong></p>',

  '<p><strong>3. Return Object (all fields optional)</strong></p>',
  '<pre>{\n  body: {},                // transformed request body\n  url: "",                 // FULL upstream URL ({{KEY}} replaced with API key)\n  url_path: "",            // path-only override (appended to upstream_url)\n  headers: {},             // request headers ({{KEY}} works here too)\n  method: "POST",          // HTTP method\n  response_format: "",     // how to parse response (see below)\n  response_parser: "",     // custom parser function string\n  stream_content_type: "", // extra content-type to detect as stream\n  retry_codes: [],         // extra HTTP codes to retry on (default: 401,403,429)\n  timeout: 300000,         // request timeout in ms\n  handled: {}              // which features you processed\n}</pre>',

  '<p><strong>4. Response Format (CRITICAL)</strong></p>',
  '<p>Frontends expect OpenAI SSE format. If your provider returns something different, you MUST set response_format:</p>',
  '<p><code>"openai"</code> — passthrough, no translation (default)<br><code>"gemini"</code> — translates Google candidates[].content.parts[] format<br><code>"anthropic"</code> — translates Claude content_block_delta events<br><code>"custom"</code> — uses your response_parser function<br><code>"raw"</code> — zero processing, pipe bytes directly</p>',
  '<p>Custom parser example: <code>response_parser: \'function(data, eventType) { var j = JSON.parse(data); return j.text || null; }\'</code></p>',
  '<p>Parser receives each SSE data: line. Return extracted text string or null to skip.</p>',

  '<p><strong>5. Example — Gemini Native</strong></p>',
  '<div class="copy-box"><button class="copy-box-btn" onclick="copyBox(\'ex-gemini\')">Copy</button><pre id="ex-gemini">module.exports = function(req, features, provider, context) {\n  var handled = {};\n  var model = context.stripped_model;\n\n  var url = "https://generativelanguage.googleapis.com/v1beta/models/"\n    + model + ":streamGenerateContent?alt=sse";\n\n  var contents = [];\n  var systemText = "";\n  var msgs = req.messages || [];\n  for (var i = 0; i &lt; msgs.length; i++) {\n    if (msgs[i].role === "system") {\n      systemText += (systemText ? "\\n" : "") + msgs[i].content;\n    } else {\n      var r = msgs[i].role === "assistant" ? "model" : "user";\n      var last = contents[contents.length - 1];\n      if (last &amp;&amp; last.role === r) {\n        last.parts[0].text += "\\n" + msgs[i].content;\n      } else {\n        contents.push({role: r, parts: [{text: msgs[i].content}]});\n      }\n    }\n  }\n\n  var body = {contents: contents};\n  if (systemText) body.systemInstruction = {parts: [{text: systemText}]};\n\n  var genConfig = {};\n  if (req.max_tokens) genConfig.maxOutputTokens = req.max_tokens;\n  if (req.temperature !== undefined) genConfig.temperature = req.temperature;\n\n  if (features.think &amp;&amp; features.think !== "off") {\n    var budget = 4096;\n    if (features.think === "high") budget = 32000;\n    if (features.think === "medium") budget = 8192;\n    if (!isNaN(Number(features.think))) budget = Number(features.think);\n    genConfig.thinkingConfig = {thinkingBudget: budget};\n    handled.think = true;\n  }\n\n  if (Object.keys(genConfig).length) body.generationConfig = genConfig;\n\n  if (features.search === "on") {\n    body.tools = [{googleSearch: {}}];\n    handled.search = true;\n  }\n\n  if (features.safety === "off") {\n    body.safetySettings = [\n      {category:"HARM_CATEGORY_HARASSMENT",threshold:"BLOCK_NONE"},\n      {category:"HARM_CATEGORY_HATE_SPEECH",threshold:"BLOCK_NONE"},\n      {category:"HARM_CATEGORY_SEXUALLY_EXPLICIT",threshold:"BLOCK_NONE"},\n      {category:"HARM_CATEGORY_DANGEROUS_CONTENT",threshold:"BLOCK_NONE"}\n    ];\n    handled.safety = true;\n  }\n\n  return {\n    body: body,\n    url: url,\n    headers: {"Content-Type": "application/json", "x-goog-api-key": "{{KEY}}"},\n    response_format: "gemini",\n    handled: handled\n  };\n};</pre></div>',

  '<p><strong>6. Example — OpenRouter (simple)</strong></p>',
  '<div class="copy-box"><button class="copy-box-btn" onclick="copyBox(\'ex-openrouter\')">Copy</button><pre id="ex-openrouter">module.exports = function(req, features, provider) {\n  var handled = {};\n\n  if (features.think) {\n    var v = features.think;\n    if (v === "off") req.reasoning = {effort: "none"};\n    else if (v === "high" || v === "medium" || v === "low") req.reasoning = {effort: v};\n    else if (v === "on") req.reasoning = {effort: "high"};\n    else if (!isNaN(parseInt(v))) req.reasoning = {max_tokens: parseInt(v)};\n    handled.think = true;\n  }\n\n  if (features.search === "on") {\n    req.plugins = [{id: "web", max_results: 5}];\n    handled.search = true;\n  }\n\n  req.transforms = ["middle-out"];\n  req.provider = {allow_fallbacks: true, require_parameters: true};\n\n  return {body: req, handled: handled};\n};</pre></div>',

  '<p><strong>7. Universal Prompt — Generate Code for Any Provider</strong></p>',
  '<p>Copy this prompt, paste into any AI, replace [PROVIDER] and [DATE]:</p>',
  '<div class="copy-box"><button class="copy-box-btn" onclick="copyBox(\'master-prompt\')">Copy</button><pre id="master-prompt">I need you to create a sandbox code function for my AI proxy gateway for: [PROVIDER NAME].\n\nBefore writing code, SEARCH THE WEB for the latest [CURRENT DATE] API docs for [PROVIDER NAME]. Find their streaming format, auth method, request body structure, and special features.\n\n## HOW MY PROXY WORKS\n\nFrontends send standard OpenAI chat/completions format. Your code transforms the request AND tells the proxy how to parse the response.\n\nThe proxy automatically:\n- Strips provider prefix from model (user sends "gm:gemini-2.5-pro", code gets context.stripped_model = "gemini-2.5-pro")\n- Injects API key wherever you put {{KEY}} (in url, headers, body)\n- Handles key rotation and retry on 401/403/429\n- Translates response back to OpenAI format based on response_format you set\n\n## FUNCTION FORMAT\n\nmodule.exports = function(req, features, provider, context) {\n  var handled = {};\n  return {\n    body: transformedBody,\n    url: "https://full-upstream-url",\n    headers: {"header": "value"},\n    method: "POST",\n    response_format: "gemini",\n    handled: handled\n  };\n};\n\n## PARAMETERS\n\n- req: OpenAI request body {model, messages[], stream, temperature, max_tokens, tools, etc}\n  NOTE: req.model already has prefix stripped. Same as context.stripped_model.\n- features: All [key=value] tags from messages e.g. {think:"high", search:"on", safety:"off"}\n- provider: {prefix, name, upstream_url, auth_type, auth_header}\n- context: {path, method, original_model, stripped_model}\n  ALWAYS use context.stripped_model for model name!\n\n## RETURN OBJECT (all optional)\n\n- body: transformed request body\n- url: full upstream URL override ({{KEY}} = API key)\n- url_path: path-only override (appended to provider.upstream_url)\n- headers: request headers ({{KEY}} works here)\n- method: HTTP method\n- response_format: CRITICAL! How proxy parses response:\n    "openai" = passthrough (default)\n    "gemini" = Google candidates[].content.parts[]\n    "anthropic" = Claude content_block_delta events\n    "custom" = uses response_parser function\n    "raw" = zero processing\n- response_parser: function string for custom format:\n    "function(data, eventType) { return extractedText || null; }"\n- stream_content_type: extra content-type to detect as stream\n- retry_codes: extra status codes to retry [500, 503]\n- timeout: ms (default 300000)\n- handled: {think:true, search:true} which features you processed\n\n## RULES\n\n- Use var not let/const\n- No require/import/fetch — sandboxed VM\n- Available: JSON, Array, Object, String, Number, Math, parseInt, parseFloat, isNaN, Date, RegExp, encodeURIComponent\n- 5 second timeout\n- DO NOT create model aliases\n- DO NOT forget response_format (without it frontend gets raw garbage)\n- ALWAYS use context.stripped_model not req.model with prefix\n\n## MAP THESE\n\n1. URL Construction (bake model into path if needed)\n2. Authentication headers (use {{KEY}})\n3. Message format transformation\n4. features.think mapping (on/off/high/medium/low/NUMBER)\n5. features.search mapping (on/off)\n6. features.safety mapping (off = most permissive)\n7. Parameter mapping (max_tokens, temperature, stop, etc)\n8. response_format declaration\n9. Streaming handling (req.stream)\n\nGenerate COMPLETE code. No placeholders. No aliases.</pre></div>',

  '</div></div></div>',
  '<div id="toasts"></div>',
  '</div>',
].join('\n');
var jsCode = [
  'var API="";',
  'var PRESETS={openai:{prefix:"opn",name:"OpenAI",upstream_url:"https://api.openai.com",auth_type:"bearer",models_endpoint:"/v1/models",think_config:\'\',search_config:\'\',sandbox:\'\',sandbox_code:\'\'},gemini:{prefix:"gm",name:"Gemini",upstream_url:"https://generativelanguage.googleapis.com",auth_type:"bearer",models_endpoint:"/v1beta/models",think_config:JSON.stringify({param_path:"generationConfig.thinkingConfig",modes:{on:{thinkingBudget:4096},off:null,low:{thinkingBudget:1024},medium:{thinkingBudget:8192},high:{thinkingBudget:32000}},numeric_field:"thinkingBudget"},null,2),search_config:JSON.stringify({inject:{on:{tools:[{googleSearch:{}}]},off:null}},null,2),sandbox:\'\',sandbox_code:\'\'},anthropic:{prefix:"cl",name:"Anthropic",upstream_url:"https://api.anthropic.com",auth_type:"x-api-key",models_endpoint:"/v1/models",think_config:JSON.stringify({param_path:"thinking",modes:{on:{type:"enabled",budget_tokens:4096},off:{type:"disabled"},low:{type:"enabled",budget_tokens:2048},medium:{type:"enabled",budget_tokens:8192},high:{type:"enabled",budget_tokens:32000}},numeric_field:"budget_tokens"},null,2),search_config:\'\',sandbox:\'\',sandbox_code:\'\'},openrouter:{prefix:"or",name:"OpenRouter",upstream_url:"https://openrouter.ai/api",auth_type:"bearer",models_endpoint:"/v1/models",think_config:\'\',search_config:\'\',sandbox:\'\',sandbox_code:"module.exports = function(req, features, provider) {\\n  var handled = {};\\n  if (features.think) {\\n    var v = features.think;\\n    if (v === \\"off\\") req.reasoning = {effort: \\"none\\"};\\n    else if (v === \\"high\\" || v === \\"medium\\" || v === \\"low\\") req.reasoning = {effort: v};\\n    else if (v === \\"on\\") req.reasoning = {effort: \\"high\\"};\\n    else if (!isNaN(parseInt(v))) req.reasoning = {max_tokens: parseInt(v)};\\n    handled.think = true;\\n  }\\n  if (features.search === \\"on\\") {\\n    req.plugins = [{id: \\"web\\", max_results: 5}];\\n    handled.search = true;\\n  }\\n  return {body: req, handled: handled};\\n};"},atxp:{prefix:"atxp",name:"ATXP.ai",upstream_url:"https://llm.atxp.ai",auth_type:"bearer",models_endpoint:"/v1/models",think_config:\'\',search_config:\'\',sandbox:\'\',sandbox_code:\'\'}};',
  'function fillPreset(name){var p=PRESETS[name];if(!p)return;document.getElementById("add-prefix").value=p.prefix;document.getElementById("add-name").value=p.name;document.getElementById("add-url").value=p.upstream_url;document.getElementById("add-auth-type").value=p.auth_type;document.getElementById("add-models-endpoint").value=p.models_endpoint;document.getElementById("add-think-config").value=p.think_config||"";;document.getElementById("add-search-config").value=p.search_config||"";document.getElementById("add-sandbox").value=p.sandbox||"";document.getElementById("add-sandbox-code").value=p.sandbox_code||"";document.getElementById("custom-header-group").style.display=p.auth_type==="custom"?"block":"none";toast("Filled " +p.name+" preset! Review and save.","info");}',
  'document.querySelectorAll(".preset-btn").forEach(function(btn){btn.addEventListener("click",function(){fillPreset(btn.dataset.preset);});});',
  'function esc(str){if(!str)return"";var d=document.createElement("div");d.textContent=String(str);return d.innerHTML;}',
  'function copyText(text){navigator.clipboard.writeText(text).then(function(){toast("Copied!","success");}).catch(function(){toast("Copy failed","error");});}',
  'function toggleAddPassword(btn){var input=btn.previousElementSibling;if(input.type==="password"){input.type="text";btn.textContent="Hide";}else{input.type="password";btn.textContent="Show";}}',
  'function copyBox(id){var el=document.getElementById(id);if(!el)return;var text=el.textContent||el.innerText;navigator.clipboard.writeText(text).then(function(){toast("Copied!","success");}).catch(function(){toast("Copy failed","error");});}',
  '',
  'var tabs=document.querySelectorAll(".tab");',
  'var panels=document.querySelectorAll(".tab-panel");',
  'function switchTab(name){tabs.forEach(function(t){t.classList.toggle("active",t.dataset.tab===name);});panels.forEach(function(p){p.classList.toggle("active",p.id==="tab-"+name);});window.location.hash=name;if(name==="providers")loadProviders();if(name==="models"){loadModelProviderFilter();loadModels();}if(name==="stats")loadStats();}',
  'tabs.forEach(function(t){t.addEventListener("click",function(){switchTab(t.dataset.tab);});});',
  'function toast(msg,type){type=type||"info";var el=document.createElement("div");el.className="toast "+type;el.textContent=msg;document.getElementById("toasts").appendChild(el);setTimeout(function(){el.remove();},4000);}',
  '',
  'document.getElementById("add-auth-type").addEventListener("change",function(e){document.getElementById("custom-header-group").style.display=e.target.value==="custom"?"block":"none";});',
  'document.getElementById("add-cloaked").addEventListener("change",function(e){document.getElementById("cloak-fields").style.display=e.target.checked?"block":"none";});',
  'document.getElementById("help-btn").addEventListener("click",function(){document.getElementById("help-modal").classList.remove("hidden");});',
  '',
  'document.getElementById("add-form").addEventListener("submit",function(e){',
  '  e.preventDefault();',
  '  var data={prefix:document.getElementById("add-prefix").value.trim(),name:document.getElementById("add-name").value.trim(),upstream_url:document.getElementById("add-url").value.trim(),auth_type:document.getElementById("add-auth-type").value,auth_header:document.getElementById("add-auth-header").value.trim()||"authorization",models_endpoint:document.getElementById("add-models-endpoint").value.trim()||"/v1/models",optional_key:document.getElementById("add-optional-key").value.trim(),sandbox:document.getElementById("add-sandbox").value.trim()||null,sandbox_code:document.getElementById("add-sandbox-code").value.trim()||null,think_config:document.getElementById("add-think-config").value.trim()||null,search_config:document.getElementById("add-search-config").value.trim()||null,cloaked:document.getElementById("add-cloaked").checked,cloak_name:document.getElementById("add-cloak-name").value.trim(),cloak_password:document.getElementById("add-cloak-password").value.trim()};',
  '  var jsonFields=["sandbox","think_config","search_config"];',
  '  for(var i=0;i<jsonFields.length;i++){var f=jsonFields[i];if(data[f]){try{JSON.parse(data[f]);}catch(ex){return toast(f+" JSON is invalid.","error");}}}',
  '  fetch(API+"/api/providers",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(data)}).then(function(res){return res.json().then(function(json){return{ok:res.ok,json:json};});}).then(function(r){if(!r.ok)return toast(r.json.error,"error");toast("Provider created!","success");document.getElementById("add-form").reset();document.getElementById("cloak-fields").style.display="none";}).catch(function(err){toast(err.message,"error");});',
  '});',
  '',
  'window._lastProviders={};window._lastCloaked=[];',
  'function loadProviders(){',
  '  Promise.all([fetch(API+"/api/providers").then(function(r){return r.json();}),fetch(API+"/api/providers/cloaked").then(function(r){return r.json();})]).then(function(results){window._lastProviders=results[0];window._lastCloaked=results[1];renderProviders();}).catch(function(err){toast(err.message,"error");});',
  '}',
  '',
  'function renderProviders(){',
  '  var search=(document.getElementById("providers-search").value||"").toLowerCase();',
  '  var providers=window._lastProviders;var cloaked=window._lastCloaked;',
  '  var c=document.getElementById("providers-list");var keys=Object.keys(providers);',
  '  if(search){keys=keys.filter(function(k){var p=providers[k];return k.indexOf(search)!==-1||(p.name||"").toLowerCase().indexOf(search)!==-1;});}',
  '  if(!keys.length){c.innerHTML="<p style=\\"color:#71717a\\">No matching providers.</p>";}',
  '  else{var h="";for(var i=0;i<keys.length;i++){var prefix=keys[i];var p=providers[prefix];h+="<div class=\\"provider-card\\" data-prefix=\\""+esc(prefix)+"\\"><div class=\\"provider-info\\"><h4>"+esc(p.name||prefix)+" <span class=\\"prefix-badge\\">"+esc(prefix)+"</span></h4><div class=\\"url-text\\">"+esc(p.upstream_url)+"</div></div><div class=\\"provider-actions\\"><button class=\\"btn small edit-btn\\" data-p=\\""+esc(prefix)+"\\">Edit</button><button class=\\"btn small cloak-btn\\" data-p=\\""+esc(prefix)+"\\">Cloak</button><button class=\\"btn small danger del-btn\\" data-p=\\""+esc(prefix)+"\\">Delete</button></div></div>";}',
  '    c.innerHTML=h;',
  '    c.querySelectorAll(".provider-card").forEach(function(card){card.addEventListener("click",function(e){if(e.target.classList.contains("edit-btn")||e.target.classList.contains("del-btn")||e.target.classList.contains("cloak-btn"))return;openDetailModal(card.dataset.prefix);});});',
  '    c.querySelectorAll(".edit-btn").forEach(function(btn){btn.addEventListener("click",function(e){e.stopPropagation();openEditModal(btn.dataset.p);});});',
  '    c.querySelectorAll(".del-btn").forEach(function(btn){btn.addEventListener("click",function(e){e.stopPropagation();openDeleteModal(btn.dataset.p);});});',
  '    c.querySelectorAll(".cloak-btn").forEach(function(btn){btn.addEventListener("click",function(e){e.stopPropagation();doCloakPrompt(btn.dataset.p);});});',
  '  }',
  '  var cs=document.getElementById("cloaked-section");var cl=document.getElementById("cloaked-list");',
  '  var filteredCloaked=cloaked;',
  '  if(search){filteredCloaked=cloaked.filter(function(cp){return cp.cloak_name.toLowerCase().indexOf(search)!==-1||cp.prefix.indexOf(search)!==-1;});}',
  '  if(!filteredCloaked.length&&!cloaked.length){cs.style.display="none";}',
  '  else{cs.style.display="block";',
  '    if(!filteredCloaked.length){cl.innerHTML="<p style=\\"color:#71717a\\">No matching cloaked providers.</p>";}',
  '    else{var ch="";for(var j=0;j<filteredCloaked.length;j++){var cp=filteredCloaked[j];ch+="<div class=\\"cloak-card\\"><span class=\\"cloak-name\\">&#128274; "+esc(cp.cloak_name)+"</span><div class=\\"cloak-actions\\"><div style=\\"position:relative;display:inline-block;flex:1\\"><input type=\\"password\\" placeholder=\\"Password\\" class=\\"cloak-pw\\" data-p=\\""+esc(cp.prefix)+"\\"><button type=\\"button\\" class=\\"pw-toggle\\" style=\\"top:8px\\" onclick=\\"toggleAddPassword(this)\\">Show</button></div><button class=\\"btn small reveal-btn\\" data-p=\\""+esc(cp.prefix)+"\\">Reveal</button><button class=\\"btn small primary uncloak-btn\\" data-p=\\""+esc(cp.prefix)+"\\">Uncloak</button></div></div>";}',
  '      cl.innerHTML=ch;',
  '      cl.querySelectorAll(".reveal-btn").forEach(function(btn){btn.addEventListener("click",function(){doReveal(btn.dataset.p);});});',
  '      cl.querySelectorAll(".uncloak-btn").forEach(function(btn){btn.addEventListener("click",function(){doUncloak(btn.dataset.p);});});',
  '    }',
  '  }',
  '}',
  'document.getElementById("providers-search").addEventListener("input",renderProviders);',
  '',
  'function doCloakPrompt(prefix){var name=prompt("Cloak display name:");if(!name)return;var pw=prompt("Set cloak password:");if(!pw)return;fetch(API+"/api/providers/"+prefix+"/cloak",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({cloak_name:name,cloak_password:pw})}).then(function(r){return r.json().then(function(j){return{ok:r.ok,json:j};});}).then(function(r){if(!r.ok)return toast(r.json.error,"error");toast("Cloaked!","success");loadProviders();}).catch(function(err){toast(err.message,"error");});}',
  '',
  'function doReveal(prefix){var pwInput=document.querySelector(".cloak-pw[data-p=\\""+prefix+"\\"]");var pw=pwInput?pwInput.value:"";if(!pw){toast("Enter password","error");return;}fetch(API+"/api/providers/cloaked/"+prefix+"/reveal",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:pw})}).then(function(r){if(!r.ok)throw new Error("Wrong password");return r.json();}).then(function(prov){var d=document.getElementById("provider-detail");var h="<h2>"+esc(prov.name)+" <span class=\\"prefix-badge\\">"+esc(prov.prefix)+"</span></h2>";h+="<div class=\\"detail-section\\"><div class=\\"detail-label\\">Upstream URL</div><div class=\\"detail-value\\">"+esc(prov.upstream_url)+"</div></div>";h+="<div class=\\"detail-section\\"><div class=\\"detail-label\\">Auth</div><div class=\\"detail-value\\">"+esc(prov.auth_type)+" / "+esc(prov.auth_header)+"</div></div>";h+="<div class=\\"detail-section\\"><div class=\\"detail-label\\">Sandbox JSON</div><pre>"+(prov.sandbox?esc(JSON.stringify(prov.sandbox,null,2)):"None")+"</pre></div>";h+="<div class=\\"detail-section\\"><div class=\\"detail-label\\">Sandbox Code</div><pre>"+(prov.sandbox_code?esc(prov.sandbox_code):"None")+"</pre></div>";d.innerHTML=h;document.getElementById("provider-modal").classList.remove("hidden");}).catch(function(err){toast(err.message,"error");});}',
  '',
  'function doUncloak(prefix){var pwInput=document.querySelector(".cloak-pw[data-p=\\""+prefix+"\\"]");var pw=pwInput?pwInput.value:"";if(!pw){toast("Enter password","error");return;}fetch(API+"/api/providers/"+prefix+"/uncloak",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:pw})}).then(function(r){return r.json().then(function(j){return{ok:r.ok,json:j};});}).then(function(r){if(!r.ok)return toast(r.json.error,"error");toast("Uncloaked!","success");loadProviders();}).catch(function(err){toast(err.message,"error");});}',
  '',
  'function openDetailModal(prefix){Promise.all([fetch(API+"/api/providers/"+prefix).then(function(r){return r.json();}),fetch(API+"/api/providers/"+prefix+"/history").then(function(r){return r.json();})]).then(function(results){var prov=results[0];var history=results[1];var d=document.getElementById("provider-detail");var h="<h2>"+esc(prov.name)+" <span class=\\"prefix-badge\\">"+esc(prov.prefix)+"</span></h2>";h+="<div class=\\"detail-section\\"><div class=\\"detail-label\\">Upstream URL</div><div class=\\"detail-value\\">"+esc(prov.upstream_url)+"</div></div>";h+="<div class=\\"detail-section\\"><div class=\\"detail-label\\">Auth</div><div class=\\"detail-value\\">"+esc(prov.auth_type)+" / "+esc(prov.auth_header)+"</div></div>";h+="<div class=\\"detail-section\\"><div class=\\"detail-label\\">Think Config</div><pre>"+(prov.think_config?esc(JSON.stringify(prov.think_config,null,2)):"None")+"</pre></div>";h+="<div class=\\"detail-section\\"><div class=\\"detail-label\\">Search Config</div><pre>"+(prov.search_config?esc(JSON.stringify(prov.search_config,null,2)):"None")+"</pre></div>";h+="<div class=\\"detail-section\\"><div class=\\"detail-label\\">Sandbox JSON</div><pre>"+(prov.sandbox?esc(JSON.stringify(prov.sandbox,null,2)):"None")+"</pre></div>";h+="<div class=\\"detail-section\\"><div class=\\"detail-label\\">Sandbox Code</div><pre>"+(prov.sandbox_code?esc(prov.sandbox_code):"None")+"</pre></div>";h+="<div class=\\"detail-section\\"><div class=\\"detail-label\\">History ("+history.length+")</div><div style=\\"max-height:200px;overflow-y:auto\\">";for(var i=0;i<history.length;i++){var entry=history[i];h+="<div class=\\"history-entry\\"><span class=\\"he-time\\">"+new Date(entry.timestamp).toLocaleString()+"</span> <span class=\\"he-action\\">"+esc(entry.action)+"</span></div>";}h+="</div></div>";d.innerHTML=h;document.getElementById("provider-modal").classList.remove("hidden");}).catch(function(err){toast(err.message,"error");});}',
  '',
  'function openEditModal(prefix){fetch(API+"/api/providers/"+prefix).then(function(r){return r.json();}).then(function(prov){var d=document.getElementById("provider-detail");var h="<h2>Edit: "+esc(prov.name)+"</h2><form id=\\"edit-form\\"><div class=\\"form-group\\"><label>Name</label><input type=\\"text\\" id=\\"edit-name\\" value=\\""+esc(prov.name||"")+"\\"></div><div class=\\"form-group\\"><label>Upstream URL</label><input type=\\"url\\" id=\\"edit-url\\" value=\\""+esc(prov.upstream_url)+"\\"></div><div class=\\"form-row\\"><div class=\\"form-group\\"><label>Auth Type</label><select id=\\"edit-auth-type\\"><option value=\\"bearer\\""+(prov.auth_type==="bearer"?" selected":"")+">Bearer</option><option value=\\"x-api-key\\""+(prov.auth_type==="x-api-key"?" selected":"")+">x-api-key</option><option value=\\"custom\\""+(prov.auth_type==="custom"?" selected":"")+">Custom</option></select></div><div class=\\"form-group\\"><label>Auth Header</label><input type=\\"text\\" id=\\"edit-auth-header\\" value=\\""+esc(prov.auth_header||"authorization")+"\\"></div></div><div class=\\"form-group\\"><label>Models Endpoint</label><input type=\\"text\\" id=\\"edit-models-endpoint\\" value=\\""+esc(prov.models_endpoint||"/v1/models")+"\\"></div><div class=\\"form-group\\"><label>Optional Key</label><input type=\\"text\\" id=\\"edit-optional-key\\" value=\\""+esc(prov.optional_key||"")+"\\"></div><div class=\\"form-group\\"><label>Think Config</label><textarea id=\\"edit-think-config\\" rows=\\"5\\">"+(prov.think_config?esc(JSON.stringify(prov.think_config,null,2)):"")+"</textarea></div><div class=\\"form-group\\"><label>Search Config</label><textarea id=\\"edit-search-config\\" rows=\\"4\\">"+(prov.search_config?esc(JSON.stringify(prov.search_config,null,2)):"")+"</textarea></div><div class=\\"form-group\\"><label>Sandbox JSON</label><textarea id=\\"edit-sandbox\\" rows=\\"8\\">"+(prov.sandbox?esc(JSON.stringify(prov.sandbox,null,2)):"")+"</textarea></div><div class=\\"form-group\\"><label>Sandbox Code</label><textarea id=\\"edit-sandbox-code\\" rows=\\"10\\">"+(prov.sandbox_code?esc(prov.sandbox_code):"")+"</textarea></div><button type=\\"submit\\" class=\\"btn primary\\">Save Changes</button></form>";d.innerHTML=h;document.getElementById("edit-form").addEventListener("submit",function(ev){ev.preventDefault();var updates={name:document.getElementById("edit-name").value.trim(),upstream_url:document.getElementById("edit-url").value.trim(),auth_type:document.getElementById("edit-auth-type").value,auth_header:document.getElementById("edit-auth-header").value.trim(),models_endpoint:document.getElementById("edit-models-endpoint").value.trim(),optional_key:document.getElementById("edit-optional-key").value.trim(),think_config:document.getElementById("edit-think-config").value.trim()||null,search_config:document.getElementById("edit-search-config").value.trim()||null,sandbox:document.getElementById("edit-sandbox").value.trim()||null,sandbox_code:document.getElementById("edit-sandbox-code").value.trim()||null};fetch(API+"/api/providers/"+prefix,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(updates)}).then(function(r){return r.json().then(function(j){return{ok:r.ok,json:j};});}).then(function(r){if(!r.ok)return toast(r.json.error,"error");toast("Updated!","success");document.getElementById("provider-modal").classList.add("hidden");loadProviders();}).catch(function(err){toast(err.message,"error");});});document.getElementById("provider-modal").classList.remove("hidden");}).catch(function(err){toast(err.message,"error");});}',
  '',
  'var deletingPrefix="";',
  'function openDeleteModal(prefix){deletingPrefix=prefix;document.getElementById("delete-password").value="";document.getElementById("delete-modal").classList.remove("hidden");}',
  'document.getElementById("delete-confirm").addEventListener("click",function(){var pw=document.getElementById("delete-password").value;fetch(API+"/api/providers/"+deletingPrefix,{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({password:pw})}).then(function(r){return r.json().then(function(j){return{ok:r.ok,json:j};});}).then(function(r){if(!r.ok)return toast(r.json.error,"error");toast("Deleted.","success");document.getElementById("delete-modal").classList.add("hidden");loadProviders();}).catch(function(err){toast(err.message,"error");});});',
  'document.getElementById("delete-cancel").addEventListener("click",function(){document.getElementById("delete-modal").classList.add("hidden");});',
  'document.querySelectorAll(".modal-backdrop").forEach(function(el){el.addEventListener("click",function(){el.closest(".modal").classList.add("hidden");});});',
  'document.querySelectorAll(".modal-close").forEach(function(el){el.addEventListener("click",function(){el.closest(".modal").classList.add("hidden");});});',
  '',
  'window._lastModels=[];',
  'function loadModelProviderFilter(){fetch(API+"/api/providers").then(function(r){return r.json();}).then(function(providers){var sel=document.getElementById("models-provider-filter");sel.innerHTML="<option value=\\"all\\">All Providers</option>";for(var prefix in providers){sel.innerHTML+="<option value=\\""+prefix+"\\">"+esc(providers[prefix].name||prefix)+" ("+prefix+")</option>";}}).catch(function(){});}',
  'function loadModels(){fetch(API+"/api/models").then(function(r){return r.json();}).then(function(models){window._lastModels=models;renderModels(models);}).catch(function(err){toast(err.message,"error");});}',
  '',
  'function renderModels(models){',
  '  var filter=document.getElementById("models-provider-filter").value;',
  '  var search=(document.getElementById("models-search").value||"").toLowerCase();',
  '  var filtered=models;',
  '  if(filter!=="all")filtered=filtered.filter(function(m){return m.owned_by===filter;});',
  '  if(search)filtered=filtered.filter(function(m){return m.id.toLowerCase().indexOf(search)!==-1;});',
  '  var countMap={};var total=models.length;',
  '  for(var ci=0;ci<models.length;ci++){var owner=models[ci].owned_by;countMap[owner]=(countMap[owner]||0)+1;}',
  '  var countsEl=document.getElementById("model-counts");',
  '  var ch="<span class=\\"count-badge total\\"><span class=\\"count-label\\">Total</span><span class=\\"count-num\\">"+total+"</span></span>";',
  '  for(var ck in countMap){ch+="<span class=\\"count-badge\\"><span class=\\"count-label\\">"+esc(ck)+"</span><span class=\\"count-num\\">"+countMap[ck]+"</span></span>";}',
  '  if(search){ch+="<span class=\\"count-badge\\"><span class=\\"count-label\\">Showing</span><span class=\\"count-num\\">"+filtered.length+"</span></span>";}',
  '  countsEl.innerHTML=ch;',
  '  var c=document.getElementById("models-list");',
  '  if(!filtered.length){c.innerHTML="<p style=\\"color:#71717a\\">No models found.</p>";return;}',
  '  var h="";for(var i=0;i<filtered.length;i++){h+="<div class=\\"model-row\\" data-model=\\""+esc(filtered[i].id)+"\\"><span class=\\"prefix\\">"+esc(filtered[i].owned_by)+"</span><span class=\\"model-id\\">"+esc(filtered[i].id)+"</span><span class=\\"copy-icon\\">&#128203;</span></div>";}',
  '  c.innerHTML=h;',
  '  c.querySelectorAll(".model-row").forEach(function(row){row.addEventListener("click",function(){copyText(row.dataset.model);});});',
  '}',
  '',
  'document.getElementById("models-provider-filter").addEventListener("change",function(){renderModels(window._lastModels);});',
  'document.getElementById("models-search").addEventListener("input",function(){renderModels(window._lastModels);});',
  'document.getElementById("fetch-models-btn").addEventListener("click",function(){var filter=document.getElementById("models-provider-filter").value;var storedKeys=localStorage.getItem("proxy-keys")||"";var parsedKeys=parseLocalKeys(storedKeys);toast("Fetching models...","info");var url=filter==="all"?API+"/api/models/fetch":API+"/api/models/fetch/"+filter;var body=filter==="all"?JSON.stringify({keys:parsedKeys}):JSON.stringify({key:parsedKeys[filter]||""});fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:body}).then(function(){toast("Models fetched!","success");loadModels();}).catch(function(err){toast(err.message,"error");});});',
  'document.getElementById("save-keys-btn").addEventListener("click",function(){var val=document.getElementById("models-keys").value.trim();localStorage.setItem("proxy-keys",val);toast("Keys saved to browser.","success");});',
  'var savedKeys=localStorage.getItem("proxy-keys")||"";document.getElementById("models-keys").value=savedKeys;',
  'function parseLocalKeys(raw){if(!raw)return{};var result={};var segs=raw.split(";");for(var i=0;i<segs.length;i++){var eqIdx=segs[i].indexOf("=");if(eqIdx===-1)continue;var prefix=segs[i].slice(0,eqIdx).trim();var key=segs[i].slice(eqIdx+1).trim().split(",")[0];if(prefix&&key)result[prefix]=key;}return result;}',
  '',
  'function loadStats(){fetch(API+"/api/stats").then(function(r){return r.json();}).then(function(stats){document.getElementById("stats-overview").innerHTML="<div class=\\"stat-card\\"><div class=\\"stat-value\\">"+stats.totalRequests.toLocaleString()+"</div><div class=\\"stat-label\\">Total Requests</div></div><div class=\\"stat-card\\"><div class=\\"stat-value\\">"+stats.totalErrors.toLocaleString()+"</div><div class=\\"stat-label\\">Total Errors</div></div><div class=\\"stat-card\\"><div class=\\"stat-value\\">"+stats.totalUniqueUsers.toLocaleString()+"</div><div class=\\"stat-label\\">Unique Users</div></div><div class=\\"stat-card\\"><div class=\\"stat-value\\">"+stats.activeNow+"</div><div class=\\"stat-label\\">Active Now</div></div>";var entries=Object.entries(stats.providers);var pc=document.getElementById("stats-providers");if(!entries.length){pc.innerHTML="<p style=\\"color:#71717a;margin-top:.5rem\\">No provider stats yet.</p>";return;}var h="";for(var i=0;i<entries.length;i++){var prefix=entries[i][0];var s=entries[i][1];h+="<div class=\\"stat-provider-row\\"><span class=\\"sp-name\\">"+esc(prefix)+"</span><div class=\\"sp-stats\\"><div>Requests: <span>"+s.requests.toLocaleString()+"</span></div><div>Errors: <span>"+s.errors.toLocaleString()+"</span></div><div>Users: <span>"+s.uniqueUsers.toLocaleString()+"</span></div></div></div>";}pc.innerHTML=h;}).catch(function(err){toast(err.message,"error");});}',
  'setInterval(function(){if(document.getElementById("tab-stats").classList.contains("active"))loadStats();},10000);',
  'var initTab=window.location.hash.slice(1)||"add";switchTab(initTab);',
].join('\n');

var fullPage = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1.0">\n<title>Proxy Gateway</title>\n<style>\n' + css + '\n</style>\n</head>\n<body>\n' + htmlBody + '\n<script>\n' + jsCode + '\n<\/script>\n</body>\n</html>';

app.get('/', function(_req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(fullPage);
});

app.use(function(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  express.json({ limit: '50mb' })(req, res, function(err) {
    if (err) req.body = {};
    next();
  });
});

app.use(trackRequest);
app.use('/api/providers', providersRouter);
app.use('/api/models', modelsRouter);
app.use('/api/stats', statsRouter);

app.get('/v1/models', async function(_req, res) {
  try {
    var models = await getAggregatedModels();
    res.json({ object: 'list', data: models });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Sandbox testing endpoints ───────────────────────────────────────────────
//
// POST /sandbox/test   { code: "JS string" | filename: "foo.js" | provider: "opn",
//                        req: {...}, stream: false }
//
// Runs the sandbox's request phase against the given request and returns the
// request descriptor the sandbox would have produced.  Useful for iterating
// on sandbox code without making real upstream calls.  Does NOT call upstream.
//
// POST /sandbox/test_response  { code/filename/provider, upstreamStatus: 200,
//                                 upstreamHeaders: {...}, upstreamBody: "..."} { }
// Runs the sandbox's response phase with the given upstream body, returns the
// downstream payload the sandbox would have emitted.
//
// GET  /sandbox/files   lists the loaded sandbox files from ./sandboxes/
// GET  /sandbox/file/:name  returns the cached source for a sandbox file

app.post('/sandbox/test', async function(req, res) {
  var body = req.body || {};
  var code = body.code || null;
  if (!code && body.filename) {
    var fetched = getSandboxCode(body.filename);
    if (fetched && fetched.error) return res.status(400).json({ error: fetched.error });
    code = fetched ? fetched.code : null;
  }
  if (!code && body.provider) {
    var p = getProvider(body.provider.toLowerCase());
    if (!p) return res.status(404).json({ error: 'provider not found' });
    if (p.sandbox_code) code = p.sandbox_code;
    else if (p.sandbox_file) {
      var f2 = getSandboxCode(p.sandbox_file);
      if (f2 && f2.error) return res.status(400).json({ error: f2.error });
      code = f2 ? f2.code : null;
    }
  }
  if (!code) return res.status(400).json({ error: 'no code supplied (send code, filename, or provider)' });

  var session = createSandboxSession(code, {
    req: body.req || {},
    features: body.features || {},
    provider: body.provider ? (getProvider(body.provider.toLowerCase()) || {}) : { name: 'test' },
    context: {
      path: body.path || '/v1/chat/completions',
      method: body.method || 'POST',
      original_model: body.original_model || (body.req && body.req.model) || '',
      stripped_model: body.stripped_model || '',
    },
    stream: !!body.stream,
    allowedHosts: body.allowed_hosts || [],
    perRequestTimeout: 5000,
    perFetchTimeout: 5000,
    maxConcurrent: 1,
    maxChain: 1,
    maxBytes: 1 * 1024 * 1024,
    log: function () {},
  });
  if (!session || session.error) return res.status(400).json({ error: session ? session.error : 'sandbox does not declare universal contract' });

  try {
    var reqResult = await session.dispatchRequest();
    var out = { request: reqResult, trace: session.getTrace() };
    session.dispose();
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message, trace: session.getTrace() });
  }
});

app.post('/sandbox/test_response', async function(req, res) {
  var body = req.body || {};
  var code = body.code || null;
  if (!code && body.filename) {
    var fetched = getSandboxCode(body.filename);
    if (fetched && fetched.error) return res.status(400).json({ error: fetched.error });
    code = fetched ? fetched.code : null;
  }
  if (!code && body.provider) {
    var p = getProvider(body.provider.toLowerCase());
    if (!p) return res.status(404).json({ error: 'provider not found' });
    if (p.sandbox_code) code = p.sandbox_code;
    else if (p.sandbox_file) {
      var f2 = getSandboxCode(p.sandbox_file);
      if (f2 && f2.error) return res.status(400).json({ error: f2.error });
      code = f2 ? f2.code : null;
    }
  }
  if (!code) return res.status(400).json({ error: 'no code supplied' });

  var session = createSandboxSession(code, {
    req: body.req || {},
    provider: body.provider ? (getProvider(body.provider.toLowerCase()) || {}) : { name: 'test' },
    allowedHosts: [],
    perRequestTimeout: 5000,
    maxChain: 1,
    log: function () {},
  });
  if (!session || session.error) return res.status(400).json({ error: session ? session.error : 'sandbox does not declare universal contract' });

  try {
    var upstreamBodyBuffer = Buffer.from(body.upstreamBody || '', 'utf8');
    var fakeHeaders = new Map();
    if (body.upstreamHeaders) {
      for (var k in body.upstreamHeaders) fakeHeaders.set(k, body.upstreamHeaders[k]);
    }
    if (body.upstreamContentType) fakeHeaders.set('content-type', body.upstreamContentType);

    var respResult = await session.dispatchResponse({
      status: body.upstreamStatus || 200,
      headers: fakeHeaders,
      bodyBuffer: upstreamBodyBuffer,
    });
    var out = { response: respResult, trace: session.getTrace() };
    session.dispose();
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message, trace: session.getTrace() });
  }
});

app.get('/sandbox/files', function(_req, res) {
  res.json({ dir: getSandboxDir(), files: listSandboxFiles() });
});

app.get('/sandbox/file/:name', function(req, res) {
  var fetched = getSandboxCode(req.params.name);
  if (!fetched) return res.status(404).json({ error: 'not found' });
  if (fetched.error) return res.status(400).json({ error: fetched.error });
  res.type('text/plain').send(fetched.code);
});

app.get('*', function(req, res, next) {
  if (req.path.startsWith('/api/') || req.path.startsWith('/v1/') || req.path.startsWith('/sandbox/')) return next();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(fullPage);
});

app.all('*', function(req, res, next) {
  if (req.path.startsWith('/sandbox/')) return next();
  return handleProxy(req, res);
});

try {
  await initStorage();
  console.log('[boot] Storage initialized');
} catch (e) {
  console.error('[boot] Storage init error:', e.message);
}

try {
  initSandboxLoader();
  console.log('[boot] Sandbox loader initialized');
} catch (e) {
  console.error('[boot] Sandbox loader init error:', e.message);
}

app.listen(PORT, '0.0.0.0', function() {
  console.log('Proxy Gateway live on :' + PORT);
});
