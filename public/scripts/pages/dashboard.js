// pages/dashboard.js — Stats dashboard with hero cards + per-provider + endpoint chips.
import { h, esc, toast, countUp, emptyState, skeleton, $ } from '../components.js';
import { Stats } from '../api.js';

let _refreshTimer = null;

export async function renderDashboard(root) {
  // Mark sidebar live indicator
  const liveDot = document.querySelector('.nav-item[data-page="dashboard"] .live');
  if (liveDot) liveDot.hidden = false;

  root.appendChild(h('div', { class: 'page-head' },
    h('h1', { html: '<b>Dashboard</b>' }),
    h('div', { class: 'actions' },
      h('span', { class: 'chip emerald', id: 'live-indicator', html: '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--color-emerald)"></span> live' }),
    ),
  ));

  // Hero stats (bento)
  const hero = h('div', { class: 'bento', id: 'stats-overview' });
  root.appendChild(hero);
  hero.appendChild(h('div', { class: 'stat-card', style: { gridColumn: 'span 3' } }, h('div', { class: 'stat-label' }, 'Loading…'), h('div', { class: 'stat-value' }, '—')));

  // Per-provider table
  const table = h('div', { class: 'glass card', style: { marginTop: '20px' } });
  root.appendChild(table);
  table.appendChild(h('h3', { style: { marginBottom: '16px' } }, 'Per-provider breakdown'));
  const providersList = h('div', { id: 'stats-providers', class: 'stack-2' });
  table.appendChild(providersList);
  providersList.appendChild(skeleton(4, 40));

  try {
    await load();
    if (_refreshTimer) clearInterval(_refreshTimer);
    _refreshTimer = setInterval(load, 10_000);
  } catch (e) {
    toast(e.message || 'Failed to load stats', 'error');
  }
}

async function load() {
  try {
    const stats = await Stats.get();
    const hero = $('#stats-overview');
    if (hero) renderHero(hero, stats);
    const pc = $('#stats-providers');
    if (pc) renderProviders(pc, stats);
  } catch (e) {
    console.error('[dashboard] load failed', e);
  }
}

function renderHero(hero, stats) {
  hero.innerHTML = '';
  const cards = [
    ['Total Requests', stats.totalRequests],
    ['Total Errors', stats.totalErrors],
    ['Unique Users', stats.totalUniqueUsers],
    ['Active Now', stats.activeNow],
  ];
  cards.forEach(([label, val], i) => {
    const card = h('div', { class: 'stat-card', style: { gridColumn: 'span 3' } },
      h('div', { class: 'stat-label' }, label),
      h('div', { class: 'stat-value', id: 'stat-val-' + i }, '0'),
    );
    hero.appendChild(card);
    setTimeout(() => countUp(card.querySelector('#stat-val-' + i), val), 60 * i);
  });
  if (stats.uptime != null) {
    const days = Math.floor(stats.uptime / 86400);
    const hours = Math.floor((stats.uptime % 86400) / 3600);
    hero.appendChild(h('div', { class: 'stat-card', style: { gridColumn: 'span 12', marginTop: '0' } },
      h('div', { class: 'stat-label' }, 'Uptime'),
      h('div', { class: 'row tight', style: { gap: '12px', flexWrap: 'wrap' } },
        h('div', { class: 'stat-value', style: { fontSize: 'var(--fs-lg)' } }, `${days}d ${hours}h`),
        h('span', { class: 'text-fade', style: { fontSize: 'var(--fs-sm)' } }, 'since last restart'),
      ),
    ));
  }
}

function renderProviders(root, stats) {
  root.innerHTML = '';
  const entries = Object.entries(stats.providers || {});
  if (!entries.length) {
    root.appendChild(emptyState('No traffic yet', 'Once your proxy starts routing requests, you\'ll see per-provider stats here.', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 12h4l3-9 4 18 3-9h4"/></svg>'));
    return;
  }
  entries.forEach(([prefix, s]) => {
    const endpoints = s.endpoints || {};
    const endpointChips = Object.entries(endpoints).sort((a, b) => b[1] - a[1]).map(([k, v]) => h('span', { class: 'chip sky' }, h('span', { class: 'mono' }, k.replace('/v1/', '').replace('/', '').slice(0, 14) || '/'), ' ', h('b', { class: 'mono' }, String(v)) ));
    const row = h('div', { style: { padding: '16px', border: '1px solid rgba(var(--glass-border))', borderRadius: 'var(--r-md)', background: 'rgba(var(--glass))' } });
    row.appendChild(h('div', { class: 'row', style: { justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' } },
      h('div', { class: 'row', style: { gap: '12px' } },
        h('span', { class: 'status-dot live' }),
        h('span', { class: 'prefix-badge mono' }, esc(prefix)),
        h('h3', { style: { margin: 0 } }, esc(prefix)),
      ),
      h('div', { class: 'row tight', style: { flexWrap: 'wrap' } },
        stat('Requests', s.requests || 0),
        stat('Errors', s.errors || 0, s.errors ? 'rose' : ''),
        stat('Users', s.uniqueUsers || 0),
      ),
    ));
    if (endpointChips.length) {
      const wrap = h('div', { class: 'row tight wrap', style: { marginTop: '12px', gap: '6px' } });
      wrap.appendChild(h('span', { class: 'text-fade', style: { fontSize: 'var(--fs-2xs)', textTransform: 'uppercase', letterSpacing: '0.06em' } }, 'Endpoints:'));
      endpointChips.forEach((c) => wrap.appendChild(c));
      row.appendChild(wrap);
    }
    root.appendChild(row);
  });
}

function stat(label, value, tone = '') {
  const cls = tone === 'rose' ? 'chip rose' : (value ? 'chip tonal' : 'chip');
  return h('span', { class: cls }, h('span', { class: 'text-fade', style: { fontSize: 'var(--fs-2xs)', textTransform: 'uppercase', letterSpacing: '0.04em' } }, label, ' '), h('b', { class: 'mono' }, String(value)));
}
