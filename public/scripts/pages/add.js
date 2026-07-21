// pages/add.js — Add Provider form with presets, cloak, sandbox.json, sandbox_code,
// allowed_hosts and new sandbox_file field.
import { h, esc, toast, attachLiveValidation, $, $$ } from '../components.js';
import { Providers, Sandbox } from '../api.js';

const PRESETS = {
  openai: {
    prefix: 'opn', name: 'OpenAI', upstream_url: 'https://api.openai.com',
    auth_type: 'bearer', models_endpoint: '/v1/models',
    icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><circle cx="12" cy="12" r="11"/></svg>',
    color: 'var(--color-emerald)',
  },
  gemini: {
    prefix: 'gm', name: 'Gemini', upstream_url: 'https://generativelanguage.googleapis.com',
    auth_type: 'bearer', models_endpoint: '/v1beta/models',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M12 2v6l-3 4 3 4 3-4-3-4z"/></svg>',
    color: 'var(--color-sky)',
  },
  anthropic: {
    prefix: 'cl', name: 'Anthropic', upstream_url: 'https://api.anthropic.com',
    auth_type: 'x-api-key', models_endpoint: '/v1/models',
    icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>',
    color: 'var(--amber)',
  },
  openrouter: {
    prefix: 'or', name: 'OpenRouter', upstream_url: 'https://openrouter.ai/api',
    auth_type: 'bearer', models_endpoint: '/v1/models',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3v18"/></svg>',
    color: '#a855f7',
  },
  atxp: {
    prefix: 'atxp', name: 'ATXP.ai', upstream_url: 'https://llm.atxp.ai',
    auth_type: 'bearer', models_endpoint: '/v1/models',
    icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    color: 'var(--amber)',
  },
};

function buildPresetBar() {
  const bar = h('div', { class: 'row wrap', style: { gap: '8px', marginBottom: '20px' } });
  Object.entries(PRESETS).forEach(([key, p]) => {
    const btn = h('button', { type: 'button', class: 'chip tonal', style: { display: 'inline-flex', gap: '6px', alignItems: 'center' }, dataset: { preset: key } });
    btn.innerHTML = `<span style="color: ${p.color}">${p.icon}</span> <span>${esc(p.name)}</span>`;
    btn.addEventListener('click', () => applyPreset(key));
    bar.appendChild(btn);
  });
  return bar;
}

function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  const form = document.getElementById('add-form');
  if (!form) return;
  form.elements.prefix.value = p.prefix;
  form.elements.name.value = p.name;
  form.elements.upstream_url.value = p.upstream_url;
  form.elements.auth_type.value = p.auth_type;
  form.elements.models_endpoint.value = p.models_endpoint;
  form.elements.optional_key.value = '';
  form.elements.auth_header.value = 'authorization';
  form.elements.sandbox.value = '';
  form.elements.sandbox_code.value = '';
  form.elements.think_config.value = '';
  form.elements.search_config.value = '';
  form.elements.sandbox_file.value = '';
  form.elements.allowed_hosts.value = '';
  form.elements.cloaked.checked = false;
  toggleCloak();
  toggleCustomHeader();
  toast(`Filled ${p.name} preset`, 'info');
}

function toggleCustomHeader() {
  const form = document.getElementById('add-form');
  if (!form) return;
  const show = form.elements.auth_type.value === 'custom';
  document.getElementById('custom-header-group').style.display = show ? '' : 'none';
}
function toggleCloak() {
  const form = document.getElementById('add-form');
  if (!form) return;
  const show = form.elements.cloaked.checked;
  document.getElementById('cloak-fields').style.display = show ? '' : 'none';
}

export function renderAdd(root) {
  root.appendChild(h('div', { class: 'page-head' },
    h('div', {},
      h('h1', { html: 'Add New <b>Provider</b>' }),
      h('p', {}, 'Configure any OpenAI-compatible endpoint. Use a preset to bootstrap, then customize freely. The sandbox fields below unlock the universal contract.'),
    ),
    h('div', { class: 'actions' },
      h('a', { class: 'btn ghost', href: '#help', html: '📖 Sandbox reference' }),
    ),
  ));

  const card = h('div', { class: 'glass card' });
  root.appendChild(card);

  card.appendChild(h('strong', { class: 'text-dim', style: { fontSize: 'var(--fs-sm)' } }, 'Quick preset'));
  card.appendChild(buildPresetBar());

  const form = h('form', { id: 'add-form', autocomplete: 'off' });
  card.appendChild(form);

  // Basics
  form.appendChild(h('div', { class: 'section-divider' }, 'Basics', h('span', { class: 'hint' }, 'Required')));
  form.appendChild(fieldRow([
    {
      label: 'Prefix', hint: 'short unique code', id: 'prefix', type: 'text',
      attrs: { name: 'prefix', required: true, maxlength: '10', placeholder: 'opn' },
    },
    {
      label: 'Display Name', id: 'name', type: 'text',
      attrs: { name: 'name', placeholder: 'OpenAI' },
    },
  ]));
  form.appendChild(formField({
    label: 'Upstream URL', hint: 'base URL only (no trailing /)', id: 'upstream_url', type: 'url',
    attrs: { name: 'upstream_url', required: true, placeholder: 'https://api.openai.com' },
  }));

  // Auth
  form.appendChild(h('div', { class: 'section-divider' }, 'Authentication'));
  form.appendChild(fieldRow([
    {
      label: 'Auth Type', id: 'auth_type', type: 'select',
      options: [['bearer', 'Bearer'], ['x-api-key', 'x-api-key'], ['custom', 'Custom header']],
      attrs: { name: 'auth_type' },
    },
    {
      label: 'Custom Header', id: 'auth_header', type: 'text',
      attrs: { name: 'auth_header', placeholder: 'x-custom-key' },
      wrapId: 'custom-header-group', wrapStyle: { display: 'none' },
    },
  ]));
  form.appendChild(formField({
    label: 'Models Endpoint', hint: 'where the proxy pulls model lists', id: 'models_endpoint', type: 'text',
    attrs: { name: 'models_endpoint', placeholder: '/v1/models' },
  }));
  form.appendChild(formField({
    label: 'Optional API Key', hint: 'for model list fetching only', id: 'optional_key', type: 'text',
    attrs: { name: 'optional_key', placeholder: 'sk-...' },
  }));

  // Cloaking
  form.appendChild(h('div', { class: 'section-divider' }, 'Cloak', h('span', { class: 'hint' }, 'optional — hide from public listing')));
  form.appendChild(h('label', { class: 'row tight', style: { cursor: 'pointer', marginBottom: '12px' } },
    h('input', { type: 'checkbox', id: 'cloak', name: 'cloaked', style: { width: 'auto' } }),
    h('span', {}, 'Cloak this provider (requires password to reveal)'),
  ));
  const cloakFields = h('div', { id: 'cloak-fields', class: 'field-row', style: { display: 'none', marginTop: '4px' } });
  cloakFields.appendChild(formField({ label: 'Cloak Display Name', id: 'cloak_name', type: 'text', attrs: { name: 'cloak_name', placeholder: 'MySecret' } }));
  cloakFields.appendChild(formField({ label: 'Cloak Password', id: 'cloak_password', type: 'password', attrs: { name: 'cloak_password', placeholder: 'reveal password' } }));
  form.appendChild(cloakFields);

  // Sandbox config
  form.appendChild(h('div', { class: 'section-divider' }, 'Sandbox', h('span', { class: 'hint' }, 'advanced — universal contract')));
  form.appendChild(formField({
    label: 'Sandbox JSON', hint: 'static request template', type: 'textarea',
    attrs: { name: 'sandbox', rows: '6', placeholder: '{ "param_path": "thinking", "modes": { ... } }' },
    validity: true,
  }));
  form.appendChild(formField({
    label: 'Sandbox Code', hint: 'JS module.exports — runs in sandboxed VM', type: 'textarea',
    attrs: { name: 'sandbox_code', rows: '10', placeholder: 'module.exports = function(req, features, provider, context) {\n  return { body: req, handled: {} };\n};' },
  }));
  form.appendChild(formField({
    label: 'Sandbox File', hint: 'hot-reloads — ./sandboxes/<name>.js', type: 'text',
    attrs: { name: 'sandbox_file', placeholder: 'gemini.js (use file from sandboxes/)' },
  }));
  form.appendChild(formField({
    label: 'Allowed Hosts', hint: 'comma-separated — limits which URLs sandbox fetch can call', type: 'text',
    attrs: { name: 'allowed_hosts', placeholder: 'api.openai.com, gemini.google.com' },
  }));

  // Thinking & search configs
  form.appendChild(h('div', { class: 'section-divider' }, 'Toggles', h('span', { class: 'hint' }, '[key=value] tags injected by chat clients')));
  form.appendChild(formField({
    label: 'Thinking Config', hint: 'JSON — applies when [think=X] tag is present', type: 'textarea',
    attrs: { name: 'think_config', rows: '6' },
    validity: true,
  }));
  form.appendChild(formField({
    label: 'Search Config', hint: 'JSON — applies when [search=on] tag is present', type: 'textarea',
    attrs: { name: 'search_config', rows: '4' },
    validity: true,
  }));

  // Actions
  const actions = h('div', { class: 'row tight', style: { marginTop: '24px' } },
    h('button', { type: 'submit', class: 'btn primary', html: '✓ Save Provider' }),
    h('button', { type: 'reset', class: 'btn ghost', html: '↺ Reset' }),
  );
  form.appendChild(actions);

  // Wire ups
  form.elements.auth_type.addEventListener('change', toggleCustomHeader);
  form.elements.cloaked.addEventListener('change', toggleCloak);

  form.addEventListener('reset', () => setTimeout(() => { toggleCustomHeader(); toggleCloak(); }, 0));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = {
      prefix: form.elements.prefix.value.trim(),
      name: form.elements.name.value.trim(),
      upstream_url: form.elements.upstream_url.value.trim(),
      auth_type: form.elements.auth_type.value,
      auth_header: form.elements.auth_header.value.trim() || 'authorization',
      models_endpoint: form.elements.models_endpoint.value.trim() || '/v1/models',
      optional_key: form.elements.optional_key.value.trim(),
      sandbox: form.elements.sandbox.value.trim() || null,
      sandbox_code: form.elements.sandbox_code.value.trim() || null,
      sandbox_file: form.elements.sandbox_file.value.trim() || null,
      allowed_hosts: form.elements.allowed_hosts.value.split(',').map((s) => s.trim()).filter(Boolean),
      think_config: form.elements.think_config.value.trim() || null,
      search_config: form.elements.search_config.value.trim() || null,
      cloaked: form.elements.cloaked.checked,
      cloak_name: form.elements.cloak_name.value.trim(),
      cloak_password: form.elements.cloak_password.value.trim(),
    };
    // Validate JSON fields
    for (const f of ['sandbox', 'think_config', 'search_config']) {
      if (data[f] === null) continue;
      try { JSON.parse(data[f]); } catch { return toast(`${f} is invalid JSON`, 'error'); }
    }
    try {
      await Providers.create(data);
      toast(`Provider "${data.prefix}" created`, 'success');
      form.reset();
      setTimeout(() => { toggleCustomHeader(); toggleCloak(); }, 0);
      window.location.hash = '#providers';
      window.location.reload();
    } catch (err) {
      toast(err.message || 'Failed', 'error');
    }
  });

  // Live validation
  $$('.field[data-json]').forEach((f) => attachLiveValidation(f));
}

// ---------- helpers ----------
function fieldRow(items) {
  const row = h('div', { class: 'field-row' });
  items.forEach((it) => row.appendChild(formField(it)));
  return row;
}

function formField({ label, hint, id, type, options = [], attrs = {}, wrapId, wrapStyle, validity }) {
  const cls = 'field' + (validity ? '' : '');
  const wrap = h('div', { class: cls, dataset: validity ? { json: '1' } : {}, id: wrapId, style: wrapStyle || {} });
  wrap.appendChild(h('label', { for: id },
    h('span', {}, label),
    hint && h('span', { class: 'hint' }, hint),
  ));
  let input;
  if (type === 'select') {
    input = h('select', { id, name: id, ...attrs });
    options.forEach(([v, lbl]) => input.appendChild(h('option', { value: v }, lbl)));
  } else if (type === 'textarea') {
    input = h('textarea', { id, name: id, ...attrs });
  } else {
    input = h('input', { type: type || 'text', id, name: id, ...attrs });
  }
  wrap.appendChild(input);
  if (validity) wrap.appendChild(h('span', { class: 'validity' }));
  return wrap;
}
