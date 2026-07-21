// pages/providers.js — providers list, search, cloak flow, edit/delete/detail modals.
import { h, esc, toast, openModal, emptyState, skeleton, countUp, $ } from '../components.js';
import { Providers } from '../api.js';

let _providers = {};
let _cloaked = [];
let _searchQuery = '';

export async function renderProviders(root) {
  root.appendChild(h('div', { class: 'page-head' },
    h('h1', { html: 'All <b>Providers</b>' }),
    h('div', { class: 'actions' },
      h('a', { class: 'btn primary', href: '#add', html: '➕ Add provider' }),
    ),
  ));

  const listCard = h('div', { class: 'glass card', id: 'providers-list-card' });
  root.appendChild(listCard);

  // Toolbar
  const toolbar = h('div', { class: 'row', style: { marginBottom: '20px', gap: '12px' } },
    h('div', { class: 'search-box', style: { flex: '1' } },
      h('svg', { class: 'icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', html: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>' }),
      h('input', { type: 'search', id: 'providers-search', placeholder: 'Search by name, prefix, or URL…', autocomplete: 'off', value: _searchQuery }),
    ),
    h('button', { class: 'btn ghost', id: 'providers-refresh', type: 'button', html: '↻ Refresh' }),
  );
  listCard.appendChild(toolbar);

  // Counts row
  const counts = h('div', { class: 'row wrap', id: 'providers-counts', style: { marginBottom: '16px' } });
  listCard.appendChild(counts);

  // Grid
  const grid = h('div', { class: 'bento', id: 'providers-grid' });
  listCard.appendChild(grid);

  // Cloaked card
  const cloakCard = h('div', { class: 'glass card', id: 'cloaked-card', style: { display: 'none', marginTop: '20px' } });
  root.appendChild(cloakCard);

  grid.appendChild(skeleton(4, 80));

  bindProvidersEvents(toolbar, grid, counts, cloakCard);

  try {
    await refresh(grid, counts, cloakCard);
  } catch (e) {
    toast(e.message || 'Failed to load', 'error');
  }
}

function bindProvidersEvents(toolbar, grid, counts, cloakCard) {
  const search = toolbar.querySelector('#providers-search');
  let debounceT;
  search.addEventListener('input', () => {
    _searchQuery = search.value;
    clearTimeout(debounceT);
    debounceT = setTimeout(() => {
      renderGrid(grid, counts, cloakCard);
    }, 160);
  });

  toolbar.querySelector('#providers-refresh').addEventListener('click', async () => {
    const btn = toolbar.querySelector('#providers-refresh');
    btn.disabled = true;
    try { await refresh(grid, counts, cloakCard); toast('Providers refreshed', 'info'); }
    catch (e) { toast(e.message || 'Failed', 'error'); }
    finally { btn.disabled = false; }
  });
}

async function refresh(grid, counts, cloakCard) {
  const [provs, clo] = await Promise.all([
    Providers.list(),
    Providers.listCloaked(),
  ]);
  _providers = provs || {};
  _cloaked = clo || [];
  renderGrid(grid, counts, cloakCard);
}

function renderGrid(grid, counts, cloakCard) {
  // Counts
  counts.innerHTML = '';
  const total = Object.keys(_providers).length;
  counts.appendChild(h('span', { class: 'chip' }, h('span', { class: 'text-fade' }, 'Visible: '), h('b', { class: 'mono' }, String(total))));
  if (_cloaked.length) counts.appendChild(h('span', { class: 'chip amber' }, h('span', {}, 'Cloaked: '), h('b', { class: 'mono' }, String(_cloaked.length))));

  // Filter
  const q = _searchQuery.toLowerCase();
  const entries = Object.entries(_providers).filter(([prefix, p]) => {
    if (!q) return true;
    return prefix.toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q) || (p.upstream_url || '').toLowerCase().includes(q);
  });

  grid.innerHTML = '';

  if (!entries.length && !_cloaked.length) {
    grid.appendChild(emptyState(
      'No providers yet',
      'Add your first provider to start routing OpenAI-compatible requests through it.',
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
      'Add a provider',
      () => { window.location.hash = 'add'; },
    ));
    cloakCard.style.display = 'none';
    return;
  }

  if (!entries.length) {
    grid.appendChild(h('div', { class: 'text-dim text-fade', style: { gridColumn: 'span 12', padding: '20px', textAlign: 'center' } }, 'No matching providers.'));
  }

  entries.forEach(([prefix, p]) => {
    const card = h('div', { class: 'provider-card', style: { gridColumn: 'span 4' } });
    card.appendChild(h('div', { class: 'pc-top' },
      h('div', { class: 'pc-title' },
        h('span', { class: 'status-dot live', 'aria-hidden': 'true' }),
        h('span', {}, esc(p.name || prefix)),
        h('span', { class: 'prefix-badge' }, esc(prefix)),
      ),
    ));
    card.appendChild(h('div', { class: 'pc-url truncate', title: p.upstream_url || '' }, esc(p.upstream_url || '')));
    const flags = [];
    if (p.sandbox_code) flags.push(['amber', 'sandbox']);
    if (p.sandbox_file) flags.push(['sky', 'file:' + p.sandbox_file]);
    if (p.cloaked) flags.push(['rose', 'cloaked']);
    if (Array.isArray(p.allowed_hosts) && p.allowed_hosts.length) flags.push(['emerald', p.allowed_hosts.length + ' hosts']);
    if (flags.length) {
      const fl = h('div', { class: 'row tight wrap', style: { marginTop: '4px' } });
      flags.forEach(([cls, lbl]) => fl.appendChild(h('span', { class: `chip ${cls}` }, lbl)));
      card.appendChild(fl);
    }
    const actions = h('div', { class: 'pc-actions' },
      iconBtn('Open', '↗', () => openDetail(prefix)),
      iconBtn('Edit', '✎', () => openEdit(prefix)),
      iconBtn('Cloak', '🔒', () => openCloak(prefix)),
      iconBtn('Delete', '✕', () => openDelete(prefix), 'danger'),
    );
    card.appendChild(actions);
    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      openDetail(prefix);
    });
    grid.appendChild(card);
  });

  // Cloaked section
  const filteredCloaked = _cloaked.filter((c) => !q || c.cloak_name.toLowerCase().includes(q) || c.prefix.toLowerCase().includes(q));
  if (!filteredCloaked.length) { cloakCard.style.display = 'none'; return; }
  cloakCard.style.display = '';
  cloakCard.innerHTML = '';
  cloakCard.appendChild(h('h3', { style: { marginBottom: '16px' } }, '🔒 Cloaked Providers'));
  const list = h('div', { class: 'stack-2' });
  cloakCard.appendChild(list);
  filteredCloaked.forEach((c) => {
    const row = h('div', { class: 'row wrap', style: { padding: '12px', border: '1px solid rgba(var(--glass-border))', borderRadius: 'var(--r-md)', background: 'rgba(var(--glass))' } });
    row.appendChild(h('div', { style: { flex: '1', minWidth: '180px' } },
      h('div', { class: 'row tight' },
        h('span', { class: 'chip amber' }, '🔒 '),
        h('strong', {}, esc(c.cloak_name || c.prefix)),
        h('span', { class: 'prefix-badge' }, esc(c.prefix)),
      ),
      h('div', { class: 'text-fade', style: { fontSize: 'var(--fs-xs)', marginTop: '4px' } }, 'Password-protected.'),
    ));
    const pwInput = h('input', { type: 'password', placeholder: 'Password', style: { maxWidth: '160px' }, dataset: { cloakedPrefix: c.prefix } });
    row.appendChild(pwInput);
    row.appendChild(iconBtn('Reveal', '👁', () => revealCloak(c.prefix, pwInput.value)));
    row.appendChild(iconBtn('Uncloak', '🔓', () => uncloakProvider(c.prefix, pwInput.value)));
    list.appendChild(row);
  });
}

function iconBtn(label, icon, onClick, variant = 'ghost') {
  const btn = h('button', { class: `btn small ${variant}`, type: 'button', 'aria-label': label, title: label }, icon);
  btn.addEventListener('click', onClick);
  return btn;
}

async function openDetail(prefix) {
  const modal = openModal(skeleton(8, 24), { size: 'large' });
  try {
    const [prov, history] = await Promise.all([
      Providers.get(prefix),
      Providers.history(prefix),
    ]);
    renderDetailModal(prov, history || []);
  } catch (e) {
    toast(e.message || 'Failed', 'error');
    modal.close();
  }
}

function renderDetailModal(prov, history) {
  const content = $('#modal-root .content');
  content.innerHTML = '';
  content.appendChild(h('h2', { html: `${esc(prov.name || prov.prefix)} <span class="prefix-badge">${esc(prov.prefix)}</span>` }));
  const grid = h('div', { class: 'bento', style: { marginTop: '20px' } });
  content.appendChild(grid);

  grid.appendChild(detailRow('span 6', 'Upstream URL', prov.upstream_url || '—'));
  grid.appendChild(detailRow('span 3', 'Auth Type', prov.auth_type || 'bearer'));
  grid.appendChild(detailRow('span 3', 'Auth Header', prov.auth_header || 'authorization'));
  grid.appendChild(detailRow('span 6', 'Models Endpoint', prov.models_endpoint || '/v1/models'));
  grid.appendChild(detailRow('span 3', 'Optional API Key', prov.optional_key ? '••••' + prov.optional_key.slice(-4) : '—'));
  grid.appendChild(detailRow('span 3', 'Sandbox File', prov.sandbox_file || '—'));
  grid.appendChild(detailRow('span 12', 'Allowed Hosts', Array.isArray(prov.allowed_hosts) && prov.allowed_hosts.length ? prov.allowed_hosts.join(', ') : '—'));

  if (prov.sandbox) grid.appendChild(detailPre('span 12', 'Sandbox JSON', JSON.stringify(prov.sandbox, null, 2)));
  if (prov.sandbox_code) grid.appendChild(detailPre('span 12', 'Sandbox Code', prov.sandbox_code));
  if (prov.think_config) grid.appendChild(detailPre('span 6', 'Think Config', JSON.stringify(prov.think_config, null, 2)));
  if (prov.search_config) grid.appendChild(detailPre('span 6', 'Search Config', JSON.stringify(prov.search_config, null, 2)));

  grid.appendChild(detailRow('span 4', 'Created', new Date(prov.created_at || Date.now()).toLocaleString()));
  grid.appendChild(detailRow('span 4', 'Last Updated', new Date(prov.updated_at || Date.now()).toLocaleString()));
  grid.appendChild(detailRow('span 4', 'Edit History', String(history.length)));

  if (history.length) {
    const historyBox = h('div', { style: { gridColumn: 'span 12', marginTop: '12px', maxHeight: '200px', overflowY: 'auto', border: '1px solid rgba(var(--glass-border))', borderRadius: 'var(--r-md)' } });
    history.slice().reverse().forEach((entry) => {
      historyBox.appendChild(h('div', { style: { padding: '8px 12px', borderBottom: '1px dashed rgba(var(--glass-border))', fontSize: 'var(--fs-xs)' } },
        h('span', { class: 'mono', style: { color: 'var(--color-text-3)' } }, new Date(entry.timestamp).toLocaleString()),
        ' · ',
        h('span', { style: { color: 'var(--color-accent)', fontWeight: '600' } }, esc(entry.action || '')),
      ));
    });
    grid.appendChild(historyBox);
  }

  content.appendChild(h('div', { class: 'actions' },
    h('button', { class: 'btn ghost', type: 'button', onclick: () => openEdit(prov.prefix, content.parentElement), html: '✎ Edit' }),
    h('button', { class: 'btn danger', type: 'button', onclick: () => openDelete(prov.prefix, content.parentElement), html: '✕ Delete' }),
  ));
}

function detailRow(span, label, value) {
  return h('div', { class: 'detail-row', style: { gridColumn: span } },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value boxed' }, typeof value === 'string' ? esc(value) : value),
  );
}
function detailPre(span, label, value) {
  return h('div', { style: { gridColumn: span } },
    h('div', { class: 'label', style: { fontSize: 'var(--fs-2xs)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-3)', fontWeight: '600', marginBottom: '4px' } }, label),
    h('div', { class: 'codeblock' },
      h('pre', { style: { maxHeight: '280px' }, html: esc(value) }),
    ),
  );
}

async function openEdit(prefix, parentReplace) {
  let content;
  if (parentReplace) content = parentReplace.querySelector('.content');
  else content = $('#modal-root .content');
  if (!content) {
    openModal(skeleton(6, 24), { size: 'large' });
    content = $('#modal-root .content');
  }
  content.innerHTML = '';
  content.appendChild(h('h2', {}, 'Edit Provider: ' + prefix));
  content.appendChild(skeleton(6, 30));
  try {
    const prov = await Providers.get(prefix);
    renderEditForm(prefix, prov, content);
  } catch (e) {
    toast(e.message || 'Failed', 'error');
  }
}

function renderEditForm(prefix, prov, content) {
  content.innerHTML = '';
  content.appendChild(h('h2', { html: `Edit: ${esc(prov.name)} <span class="prefix-badge">${esc(prefix)}</span>` }));
  const form = h('form', { id: 'edit-form' });
  content.appendChild(form);

  form.appendChild(field('Display Name', 'text', 'edit-name', { value: prov.name || '' }));
  form.appendChild(field('Upstream URL', 'url', 'edit-url', { value: prov.upstream_url || '', required: true }));
  form.appendChild(h('div', { class: 'field-row' },
    selectField('Auth Type', 'edit-auth-type', [['bearer', 'Bearer'], ['x-api-key', 'x-api-key'], ['custom', 'Custom']], prov.auth_type || 'bearer'),
    field('Auth Header', 'text', 'edit-auth-header', { value: prov.auth_header || 'authorization' } ),
  ));
  form.appendChild(field('Models Endpoint', 'text', 'edit-models-endpoint', { value: prov.models_endpoint || '/v1/models' }));
  form.appendChild(field('Optional API Key', 'text', 'edit-optional-key', { value: prov.optional_key || '' }));
  form.appendChild(field('Sandbox File', 'text', 'edit-sandbox-file', { value: prov.sandbox_file || '', placeholder: 'gemini.js (from ./sandboxes/)' }));
  form.appendChild(field('Allowed Hosts (comma-separated)', 'text', 'edit-allowed-hosts', { value: Array.isArray(prov.allowed_hosts) ? prov.allowed_hosts.join(', ') : '' }));
  form.appendChild(textarea('Think Config (JSON)', 'edit-think-config', prov.think_config ? JSON.stringify(prov.think_config, null, 2) : '', 5));
  form.appendChild(textarea('Search Config (JSON)', 'edit-search-config', prov.search_config ? JSON.stringify(prov.search_config, null, 2) : '', 4));
  form.appendChild(textarea('Sandbox JSON', 'edit-sandbox', prov.sandbox ? JSON.stringify(prov.sandbox, null, 2) : '', 8));
  form.appendChild(textarea('Sandbox Code', 'edit-sandbox-code', prov.sandbox_code || '', 12));

  const save = h('button', { type: 'submit', class: 'btn primary', html: '✓ Save Changes' }, );
  const cancel = h('button', { type: 'button', class: 'btn ghost', html: 'Cancel' });
  cancel.addEventListener('click', () => openDetail(prefix));
  form.appendChild(h('div', { class: 'row tight', style: { gap: '12px', marginTop: '20px' } }, save, cancel));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const updates = {
      name: form['edit-name'].value.trim(),
      upstream_url: form['edit-url'].value.trim(),
      auth_type: form['edit-auth-type'].value,
      auth_header: form['edit-auth-header'].value.trim(),
      models_endpoint: form['edit-models-endpoint'].value.trim(),
      optional_key: form['edit-optional-key'].value.trim(),
      sandbox_file: form['edit-sandbox-file'].value.trim() || null,
      allowed_hosts: form['edit-allowed-hosts'].value.split(',').map((s) => s.trim()).filter(Boolean),
      think_config: form['edit-think-config'].value.trim() || null,
      search_config: form['edit-search-config'].value.trim() || null,
      sandbox: form['edit-sandbox'].value.trim() || null,
      sandbox_code: form['edit-sandbox-code'].value.trim() || null,
    };
    for (const f of ['sandbox', 'think_config', 'search_config']) {
      if (updates[f] === null) continue;
      try { JSON.parse(updates[f]); } catch { return toast(`${f} is invalid JSON`, 'error'); }
    }
    try {
      await Providers.update(prefix, updates);
      toast('Provider updated', 'success');
      openDetail(prefix);
      // Refresh list background without blocking
      refresh($('#providers-grid'), $('#providers-counts'), $('#cloaked-card'));
    } catch (e) {
      toast(e.message || 'Failed to update', 'error');
    }
  });
}

function openCloak(prefix) {
  openModal(
    h('div', {},
      h('h2', {}, 'Cloak Provider ' + prefix),
      h('p', { class: 'text-dim', style: { marginTop: '4px', marginBottom: '16px' } }, 'Hide this provider from the public list. Requires a password to reveal.'),
      h('div', { class: 'field' },
        h('label', { for: 'cloak-name-input' }, 'Cloak Display Name'),
        h('input', { type: 'text', id: 'cloak-name-input', placeholder: 'MySecret', autocomplete: 'off' }),
      ),
      h('div', { class: 'field' },
        h('label', { for: 'cloak-pw-input' }, 'Reveal Password'),
        h('input', { type: 'password', id: 'cloak-pw-input', placeholder: 'reveal password', autocomplete: 'new-password' }),
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', type: 'button', html: '🔒 Cloak it', onclick: async () => {
          const name = $('#cloak-name-input').value.trim() || prefix;
          const pw = $('#cloak-pw-input').value;
          if (!pw) return toast('Enter a reveal password', 'error');
          try {
            await Providers.cloak(prefix, { cloak_name: name, cloak_password: pw });
            toast('Provider cloaked', 'success');
            const m = $('#modal-root'); m.classList.remove('open'); m.innerHTML = '';
            refresh($('#providers-grid'), $('#providers-counts'), $('#cloaked-card'));
          } catch (e) { toast(e.message || 'Failed', 'error'); }
        } }),
        h('button', { class: 'btn ghost', type: 'button', html: 'Cancel', onclick: () => { const m = $('#modal-root'); m.classList.remove('open'); m.innerHTML = ''; } }),
      ),
    ),
    { size: 'small' },
  );
}

function openDelete(prefix) {
  openModal(
    h('div', {},
      h('h2', {}, 'Delete Provider ' + prefix),
      h('p', { class: 'text-dim', style: { marginTop: '4px', marginBottom: '16px' } }, 'Enter admin password to remove this provider. This cannot be undone.'),
      h('div', { class: 'field' },
        h('label', { for: 'delete-pw' }, 'Admin Password'),
        h('input', { type: 'password', id: 'delete-pw', placeholder: 'admin password', autocomplete: 'off' }),
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn danger', type: 'button', html: '✕ Delete', onclick: async () => {
          const pw = $('#delete-pw').value;
          if (!pw) return toast('Enter admin password', 'error');
          try {
            await Providers.remove(prefix, pw);
            toast('Provider deleted', 'success');
            const m = $('#modal-root'); m.classList.remove('open'); m.innerHTML = '';
            refresh($('#providers-grid'), $('#providers-counts'), $('#cloaked-card'));
          } catch (e) { toast(e.message || 'Failed', 'error'); }
        } }),
        h('button', { class: 'btn ghost', type: 'button', html: 'Cancel', onclick: () => { const m = $('#modal-root'); m.classList.remove('open'); m.innerHTML = ''; } }),
      ),
    ),
    { size: 'small' },
  );
}

async function revealCloak(prefix, pw) {
  if (!pw) return toast('Enter the reveal password', 'error');
  try {
    const prov = await Providers.reveal(prefix, { password: pw });
    openModal(
      h('div', {},
        h('h2', { html: `${esc(prov.name)} <span class="prefix-badge">${esc(prov.prefix)}</span>` }),
        h('div', { class: 'stack', style: { marginTop: '16px' } },
          detailRow('', 'Upstream URL', esc(prov.upstream_url || '')),
          detailRow('', 'Auth', esc(prov.auth_type + ' / ' + (prov.auth_header || 'authorization'))),
          detailRow('', 'Sandbox JSON', esc(prov.sandbox ? JSON.stringify(prov.sandbox, null, 2) : '—')),
          detailRow('', 'Sandbox Code', esc(prov.sandbox_code || '—')),
        ),
      ),
      { size: 'large' },
    );
  } catch (e) {
    toast(e.message || 'Reveal failed', 'error');
  }
}

async function uncloakProvider(prefix, pw) {
  if (!pw) return toast('Enter the cloak password', 'error');
  try {
    await Providers.uncloak(prefix, { password: pw });
    toast('Provider uncloaked', 'success');
    refresh($('#providers-grid'), $('#providers-counts'), $('#cloaked-card'));
  } catch (e) {
    toast(e.message || 'Failed', 'error');
  }
}

// — tiny helpers —
function field(label, type, id, attrs = {}) {
  const wrap = h('div', { class: 'field' });
  wrap.appendChild(h('label', { for: id }, label));
  wrap.appendChild(h('input', { type, id, name: id, ...attrs }));
  return wrap;
}
function selectField(label, id, options, selected) {
  const wrap = h('div', { class: 'field' });
  wrap.appendChild(h('label', { for: id }, label));
  const sel = h('select', { id, name: id });
  options.forEach(([v, l]) => sel.appendChild(h('option', { value: v, selected: v === selected }, l)));
  wrap.appendChild(sel);
  return wrap;
}
function textarea(label, id, value, rows = 4) {
  const wrap = h('div', { class: 'field' });
  wrap.appendChild(h('label', { for: id }, label));
  wrap.appendChild(h('textarea', { id, name: id, rows: String(rows) }, value || ''));
  return wrap;
}
