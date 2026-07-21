// pages/models.js — Models browser with filter, counts, click-to-copy, API keys.
import { h, esc, toast, copyText, emptyState, skeleton, $ } from '../components.js';
import { Models, Providers, Store } from '../api.js';

let _models = [];
let _providers = {};
let _filter = 'all';
let _search = '';

export async function renderModels(root) {
  const fetchBtn = h('button', { class: 'btn primary', id: 'fetch-models-btn', type: 'button', html: '↓ Fetch Models' });
  root.appendChild(h('div', { class: 'page-head' },
    h('h1', { html: 'All <b>Models</b>' }),
    h('div', { class: 'actions' }, fetchBtn),
  ));

  const card = h('div', { class: 'glass card' });
  root.appendChild(card);

  // Toolbar: provider filter + search
  const toolbar = h('div', { class: 'row', style: { marginBottom: '16px', gap: '12px', flexWrap: 'wrap' } },
    h('select', { id: 'models-provider-filter', style: { width: 'auto', minWidth: '180px' } },
      h('option', { value: 'all' }, 'All Providers'),
    ),
    h('div', { class: 'search-box', style: { flex: '1', minWidth: '240px' } },
      h('svg', { class: 'icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', html: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>' }),
      h('input', { type: 'search', id: 'models-search', placeholder: 'Search by model id…', autocomplete: 'off' }),
    ),
  );
  card.appendChild(toolbar);

  // Chip count row
  const counts = h('div', { class: 'row wrap', id: 'model-counts', style: { marginBottom: '16px' } });
  card.appendChild(counts);

  // API keys panel
  const keysWrap = h('details', { class: 'disclosure' });
  keysWrap.appendChild(h('summary', {}, '🔑 API Keys (browser-only)'));
  const kw = h('div', { class: 'disclosure-body' });
  kw.appendChild(h('p', { class: 'text-fade', style: { fontSize: 'var(--fs-xs)', marginBottom: '8px' } }, 'Format: prefix=key;prefix=key (one segment per provider). Stored in your browser only.'));
  kw.appendChild(h('textarea', { id: 'models-keys', rows: '3', placeholder: 'opn=sk-abc123;gm=AIza-xyz;or=sk-or-...' }));
  kw.appendChild(h('div', { class: 'row tight', style: { marginTop: '8px' } },
    h('button', { class: 'btn small primary', id: 'save-keys-btn', type: 'button' }, 'Save to Browser'),
    h('span', { class: 'text-fade', id: 'keys-status', style: { fontSize: 'var(--fs-xs)' } }),
  ));
  keysWrap.appendChild(kw);
  card.appendChild(keysWrap);

  // Models grid
  const list = h('div', { id: 'models-list', class: 'stack-2', style: { marginTop: '16px' } });
  card.appendChild(list);

  // Wire ups
  const filterEl = toolbar.querySelector('#models-provider-filter');
  const searchEl = toolbar.querySelector('#models-search');
  filterEl.addEventListener('change', () => { _filter = filterEl.value; renderList(); });
  searchEl.addEventListener('input', () => { _search = searchEl.value.toLowerCase(); renderList(); });
  fetchBtn.addEventListener('click', onFetchModels);
  card.querySelector('#save-keys-btn').addEventListener('click', () => {
    const v = card.querySelector('#models-keys').value.trim();
    Store.setRaw('proxy-keys', v);
    card.querySelector('#keys-status').textContent = 'Saved ✓';
    toast('Keys saved to browser.', 'success');
    setTimeout(() => card.querySelector('#keys-status').textContent = '', 1800);
  });

  // Init
  list.appendChild(skeleton(5, 28));
  try {
    [_providers, _models] = await Promise.all([Providers.list(), Models.list()]);
    _models = _models || [];
    populateFilter();
    renderList();
  } catch (e) {
    toast(e.message || 'Failed to load models', 'error');
  }

  // Restore saved keys
  const saved = Store.getRaw('proxy-keys', '');
  card.querySelector('#models-keys').value = saved;

  function populateFilter() {
    filterEl.innerHTML = '';
    filterEl.appendChild(h('option', { value: 'all' }, 'All Providers'));
    Object.entries(_providers).forEach(([prefix, p]) => {
      filterEl.appendChild(h('option', { value: prefix }, `${p.name || prefix} (${prefix})`));
    });
    filterEl.value = _filter || 'all';
  }

  function renderList() {
    const filtered = _models.filter((m) => {
      if (_filter !== 'all' && m.owned_by !== _filter) return false;
      if (_search && !(m.id || '').toLowerCase().includes(_search)) return false;
      return true;
    });
    list.innerHTML = '';
    counts.innerHTML = '';
    const total = _models.length;
    const byOwner = {};
    _models.forEach((m) => { byOwner[m.owned_by] = (byOwner[m.owned_by] || 0) + 1; });
    counts.appendChild(h('span', { class: 'chip tonal' }, h('b', { class: 'mono' }, String(total)), ' ', h('span', { class: 'text-fade' }, 'total')));
    Object.entries(byOwner).forEach(([prefix, n]) => {
      const c = h('span', { class: 'chip' }, h('span', { class: 'mono', style: { color: 'var(--color-accent)' } }, esc(prefix)), ' ', h('b', { class: 'mono' }, String(n)));
      counts.appendChild(c);
    });
    if (_search) counts.appendChild(h('span', { class: 'chip' }, h('b', { class: 'mono' }, String(filtered.length)), ' ', h('span', { class: 'text-fade' }, 'showing')));

    if (!filtered.length) {
      list.appendChild(emptyState('No models found', _search ? `Nothing matches "${_search}".` : 'Hit Fetch Models above to pull model lists from your providers.', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M9 9.5h.01M15 9.5h.01M8 15a4 4 0 0 1 8 0"/></svg>'));
      return;
    }
    filtered.slice(0, 200).forEach((m) => {
      const row = h('div', { class: 'list-row' },
        h('span', { class: 'prefix' }, esc(m.owned_by || '')),
        h('span', { class: 'id' }, esc(m.id || '')),
        h('span', { class: 'copy-tip' }, '⧉ Click to copy'),
      );
      row.addEventListener('click', async () => {
        const ok = await copyText(m.id || '');
        if (ok) {
          toast(`Copied ${m.id}`, 'success', 1800);
          row.querySelector('.copy-tip').textContent = '✓ Copied';
          setTimeout(() => row.querySelector('.copy-tip').textContent = '⧉ Click to copy', 1600);
        }
      });
      list.appendChild(row);
    });
    if (filtered.length > 200) {
      list.appendChild(h('div', { class: 'text-fade', style: { padding: '12px', textAlign: 'center', fontSize: 'var(--fs-xs)' } }, `Showing first 200 of ${filtered.length}. Refine search to see more.`));
    }
  }

  async function onFetchModels() {
    const btn = fetchBtn;
    btn.disabled = true;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="60 90" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></svg> Fetching…';
    const rawKeys = Store.getRaw('proxy-keys', '');
    const keys = parseLocalKeys(rawKeys);
    try {
      if (_filter === 'all') await Models.fetchAll(keys);
      else await Models.fetchOne(_filter, keys[_filter] || '');
      _models = (await Models.list()) || [];
      populateFilter();
      renderList();
      toast(`Fetched ${_models.length} models`, 'success');
    } catch (e) {
      toast(e.message || 'Fetch failed', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '↓ Fetch Models';
    }
  }
}

function parseLocalKeys(raw) {
  if (!raw) return {};
  const out = {};
  raw.split(';').forEach((seg) => {
    const eq = seg.indexOf('=');
    if (eq === -1) return;
    const prefix = seg.slice(0, eq).trim();
    const key = seg.slice(eq + 1).trim().split(',')[0];
    if (prefix && key) out[prefix] = key;
  });
  return out;
}
