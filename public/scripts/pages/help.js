// pages/help.js — Sandbox code reference.
import { h, esc } from '../components.js';

const SECTIONS = [
  ['intro', 'Universal Contract', [
    ['overview', 'Overview', `<p>The sandbox contract is a small JavaScript module you can attach to any provider. The proxy calls it at known phases, and your code reshapes the request, response, and/or streaming chunks. Old legacy sandboxes (<code>module.exports = function(req, features, provider, context)</code>) keep working unchanged — the proxy auto-detects them.</p>`],
    ['signature', 'Function Signature', `<p>The universal contract is an object with a <code>true</code> flag and any of these phases:</p>`, `module.exports = {
  universal: true,
  request(session) { ... },
  response(session) { ... },
  stream_chunk(session, raw) { ... },
  stream_end(session) { ... },
  error(session) { ... },
};`],
    ['session', 'Async Fetch (Universal mode only)', `<p>Inside a phase, <code>await session.fetch(url, opts)</code> issues an HTTP request <em>only</em> to hosts on the provider's <strong>allowed_hosts</strong> list. Use this to chain-poll or fetch credentials. The returned object has <code>status</code>, <code>headers</code> (Map), <code>body</code> (string), and <code>ok</code> boolean.</p>`, `// Poll upstream for a one-time URL, then return it as the body
var resp = await session.fetch(provider.upstream_url + '/v1/sign', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ user: 'me' }),
});
if (resp.ok) {
  return { body: JSON.parse(resp.body), next_request: { url: resp.body } };
}`],
  ]],
  ['params', 'Parameters', [
    ['session-fields', 'Session contents', `<p>The <code>session</code> passed to each phase carries everything you need and collects everything you produce.</p>`],
  ]],
  ['returns', 'Return object', [
    ['req-return', 'request() return', `<p>Reshape the request, override the URL/headers, or signal retry via the fields below.</p>`, `return {
  body: req,                       // new request body
  url: '',                         // full upstream URL ({{KEY}} replaces with key)
  url_path: '',                    // path appended to provider.upstream_url
  headers: {},                     // request headers
  method: 'POST',                  // HTTP method
  retry_codes: [500, 503],         // extra codes to retry on
  timeout: 300000,                 // request timeout in ms
  handled: { think: true, search: true }, // mark features as processed
  response_format: 'openai',       // openai | gemini | anthropic | custom | raw
  stream_content_type: '...',       // extra content-type to detect as stream
  next_request: {...}              // chain-poll: dispatch another request
};`],
  ]],
  ['examples', 'Examples', [
    ['ex-gemini', 'Gemini native', '', `module.exports = {
  universal: true,
  request(s) {
    var req = s.req;
    var features = s.features;
    var model = s.context.stripped_model;
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/'
      + model + ':streamGenerateContent?alt=sse';
    var contents = [];
    var sys = '';
    (req.messages || []).forEach((m) => {
      if (m.role === 'system') sys += (sys ? '\\n' : '') + m.content;
      else {
        var r = m.role === 'assistant' ? 'model' : 'user';
        var last = contents[contents.length - 1];
        if (last && last.role === r) last.parts[0].text += '\\n' + m.content;
        else contents.push({ role: r, parts: [{ text: m.content }] });
      }
    });
    var body = { contents: contents };
    if (sys) body.systemInstruction = { parts: [{ text: sys }] };
    body.generationConfig = {
      maxOutputTokens: req.max_tokens || 8192,
      temperature: req.temperature,
    };
    if (features.think === 'high') {
      body.generationConfig.thinkingConfig = { thinkingBudget: 32000 };
      s.handled.think = true;
    }
    if (features.search === 'on') {
      body.tools = [{ googleSearch: {} }];
      s.handled.search = true;
    }
    return { body: body, url: url, response_format: 'gemini' };
  },
};`],
    ['ex-anthropic', 'Anthropic native', '', `module.exports = {
  universal: true,
  request(s) {
    var req = s.req, f = s.features;
    var body = {
      model: s.context.stripped_model,
      messages: (req.messages || []).filter(m => m.role !== 'system').map(m => ({
        role: m.role, content: m.content
      })),
      max_tokens: req.max_tokens || 4096,
    };
    var sys = (req.messages || []).filter(m => m.role === 'system').map(m => m.content).join('\\n');
    if (sys) body.system = sys;
    if (f.think === 'high') {
      body.thinking = { type: 'enabled', budget_tokens: 32000 };
      s.handled.think = true;
    }
    return { body: body, response_format: 'anthropic' };
  },
};`],
  ]],
  ['legacy', 'Legacy contract', [
    ['legacy-fn', 'Legacy sandbox (still supported)', `<p>The proxy auto-detects the old signature. No changes needed.</p>`, `module.exports = function(req, features, provider, context) {
  var handled = {};
  return {
    body: req,
    url: "",
    headers: {},
    method: "POST",
    response_format: "openai",
    handled: handled
  };
};`],
  ]],
];

export function renderHelp(root) {
  root.appendChild(h('div', { class: 'page-head' },
    h('h1', { html: '<b>Reference</b>' }),
  ));

  const grid = h('div', { class: 'bento' });
  root.appendChild(grid);

  const tocCard = h('div', { class: 'glass card-pad-sm', style: { gridColumn: 'span 3', position: 'sticky', top: '80px', alignSelf: 'flex-start' } });
  const bodyCard = h('div', { class: 'glass card', style: { gridColumn: 'span 9' } });
  grid.appendChild(tocCard);
  grid.appendChild(bodyCard);

  const tocList = h('nav', { class: 'stack-2', 'aria-label': 'Table of contents' });
  tocCard.appendChild(h('strong', { style: { display: 'block', marginBottom: '12px', fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-3)' } }, 'On this page'));
  tocCard.appendChild(tocList);

  SECTIONS.forEach(([sid, sTitle, items]) => {
    const sIdx = h('a', { href: '#' + sid, style: { display: 'block', fontWeight: '600', fontSize: 'var(--fs-sm)', margin: '12px 0 4px', color: 'var(--color-text-1)', textDecoration: 'none' } }, sTitle);
    tocList.appendChild(sIdx);
    items.forEach(([iid, ititle]) => {
      tocList.appendChild(h('a', { href: '#' + iid, style: { display: 'block', color: 'var(--color-text-3)', fontSize: 'var(--fs-xs)', padding: '2px 0 2px 12px', textDecoration: 'none' } }, ititle));
    });
  });

  const content = h('div', { class: 'help-content', style: { maxWidth: '60ch' } });
  bodyCard.appendChild(content);

  SECTIONS.forEach(([sid, sTitle, items]) => {
    content.appendChild(h('h2', { id: sid, style: { fontSize: 'var(--fs-xl)', fontWeight: '700', marginTop: '24px', marginBottom: '12px' } }, sTitle));
    items.forEach(([iid, ititle, prose, code]) => {
      content.appendChild(h('h3', { id: iid, style: { fontSize: 'var(--fs-md)', fontWeight: '600', marginTop: '20px', marginBottom: '6px', color: 'var(--color-text-1)' } }, ititle));
      if (prose) content.appendChild(h('div', { html: prose }));
      if (code) {
        const cb = h('div', { class: 'codeblock' },
          h('div', { class: 'header' },
            h('span', { class: 'lang' }, 'js'),
            h('button', { class: 'copy-btn', type: 'button', dataset: { copy: iid } }, '⧉ Copy'),
          ),
          h('pre', { id: iid }, code),
        );
        content.appendChild(cb);
        content.appendChild(h('div', { style: { height: '12px' } }));
      }
    });
  });

  // Sticky-active TOC highlight
  const obs = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        const id = e.target.id;
        tocList.querySelectorAll('a').forEach((a) => a.style.color = a.getAttribute('href') === '#' + id ? 'var(--color-accent)' : 'var(--color-text-3)');
      }
    });
  }, { rootMargin: '-20% 0px -70% 0px' });
  content.querySelectorAll('[id]').forEach((el) => obs.observe(el));
}
