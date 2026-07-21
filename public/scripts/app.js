// app.js — app bootstrap: router, page registry, theme init.
import { $, $$, Theme, attachRipple, wireCopyButtons, toast } from './components.js';
import { initSpotlight } from './spotlight.js';

import { renderAdd } from './pages/add.js';
import { renderProviders } from './pages/providers.js';
import { renderModels } from './pages/models.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderSandbox } from './pages/sandbox.js';
import { renderHelp } from './pages/help.js';

const PAGES = {
  add: { label: 'Add Provider', render: renderAdd },
  providers: { label: 'Providers', render: renderProviders },
  models: { label: 'Models', render: renderModels },
  sandbox: { label: 'Sandbox', render: renderSandbox },
  help: { label: 'Help', render: renderHelp },
  dashboard: { label: 'Dashboard', render: renderDashboard },
};

export function nav(name) {
  if (!PAGES[name]) name = 'add';
  if (window.location.hash !== '#' + name) window.location.hash = name;
  else _render(name);
}
function _render(name) {
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === name));
  const root = $('#page-root');
  root.innerHTML = '';
  try {
    const page = PAGES[name];
    page.render(root);
  } catch (e) {
    console.error(e);
    toast('Failed to render ' + name + ': ' + (e.message || e), 'error');
  }
}

function init() {
  Theme.init();
  attachRipple(document);
  wireCopyButtons(document);

  $('#theme-toggle').addEventListener('click', (e) => {
    const seg = e.target.closest('.seg');
    if (!seg) return;
    Theme.set(seg.dataset.themeVal);
  });

  $$('.nav-item').forEach((n) => {
    n.addEventListener('click', (e) => {
      e.preventDefault();
      nav(n.dataset.page);
    });
  });

  window.addEventListener('hashchange', () => {
    const t = window.location.hash.slice(1);
    _render(PAGES[t] ? t : 'add');
  });

  initSpotlight();
  $('#spotlight-trigger').addEventListener('click', () => {
    const r = $('#spotlight-root');
    if (r.classList.contains('open')) return;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
  });

  const initial = window.location.hash.slice(1);
  _render(PAGES[initial] ? initial : 'add');
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === (PAGES[initial] ? initial : 'add')));
}

init();
