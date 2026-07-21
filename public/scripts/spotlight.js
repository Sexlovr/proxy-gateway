// spotlight.js — Ctrl/Cmd+K command palette.
import { $, $$, h, Theme } from './components.js';

const ACTIONS = [
  { icon: '➕', kind: 'page', label: 'Add Provider', hash: 'add' },
  { icon: '🟪', kind: 'page', label: 'Browse Providers', hash: 'providers' },
  { icon: '🎯', kind: 'page', label: 'Browse Models', hash: 'models' },
  { icon: '⚡', kind: 'page', label: 'Open Sandbox Playground', hash: 'sandbox' },
  { icon: '📊', kind: 'page', label: 'View Dashboard', hash: 'dashboard' },
  { icon: '❓', kind: 'page', label: 'Help Reference', hash: 'help' },
  { icon: '☾', kind: 'theme', label: 'Theme: Dark', go: () => Theme.set('dark') },
  { icon: '☀', kind: 'theme', label: 'Theme: Light', go: () => Theme.set('light') },
  { icon: '⎈', kind: 'theme', label: 'Theme: Cyber', go: () => Theme.set('cyber') },
];

let _open = false;
let _selected = 0;
let _matches = [];
let _input = null;
let _results = null;

export function initSpotlight() {
  const root = $('#spotlight-root');
  root.innerHTML = '';
  const panel = h('div', { class: 'panel' });
  const searchWrap = h('div', { style: { display: 'flex', alignItems: 'center', padding: '0 4px 0 16px' } },
    h('svg', { style: { width: 18, height: 18, color: 'var(--color-text-3)', flexShrink: 0 }, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', html: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>' }),
    _input = h('input', { type: 'text', placeholder: 'Type a command, page, or theme…', autocomplete: 'off', spellcheck: 'false' }),
  );
  _results = h('div', { class: 'results' });
  panel.appendChild(searchWrap);
  panel.appendChild(_results);
  const backdrop = h('div', { class: 'backdrop' });
  root.appendChild(backdrop);
  root.appendChild(panel);

  const close = () => { _open = false; root.classList.remove('open'); root.setAttribute('aria-hidden', 'true'); document.body.style.overflow = ''; _input.value = ''; _matches = ACTIONS; _selected = 0; render(); };
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _open) { e.preventDefault(); close(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (_open) close(); else open(); }
  });
  _input.addEventListener('input', () => { _selected = 0; render(); });
  _input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); _selected = Math.min(_matches.length - 1, _selected + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); _selected = Math.max(0, _selected - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); const m = _matches[_selected]; if (m) { runAction(m); close(); } }
  });
}

function open() {
  const root = $('#spotlight-root');
  root.classList.add('open');
  root.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  _open = true;
  _matches = ACTIONS;
  _selected = 0;
  render();
  setTimeout(() => _input.focus(), 30);
}

function render() {
  const q = (_input.value || '').toLowerCase().trim();
  _matches = q ? ACTIONS.filter((a) => a.label.toLowerCase().includes(q)) : ACTIONS;
  _selected = Math.min(_selected, _matches.length - 1);
  _results.innerHTML = '';
  if (!_matches.length) {
    _results.appendChild(h('div', { style: { padding: 'var(--sp-4)', color: 'var(--color-text-3)', textAlign: 'center', fontSize: 'var(--fs-sm)' } }, 'No matches'));
    return;
  }
  _matches.forEach((m, i) => {
    const el = h('div', { class: `result-item ${i === _selected ? 'active' : ''}` },
      h('span', { class: 'icon', html: m.icon }),
      h('span', { class: 'label' }, m.label),
      h('span', { class: 'kind' }, m.kind),
    );
    el.addEventListener('mouseenter', () => { _selected = i; render(); });
    el.addEventListener('click', () => { runAction(m); const r = $('#spotlight-root'); r.classList.remove('open'); _open = false; document.body.style.overflow = ''; _input.value = ''; });
    _results.appendChild(el);
  });
}

function runAction(m) {
  if (m.hash) { window.location.hash = m.hash; }
  else if (typeof m.go === 'function') m.go();
}
