// components.js — tiny DOM helpers + reusable UI primitives.

// ---------- DOM helpers ----------
export const h = (tag, attrs, ...children) => {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
  return el;
};

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- esc (avoid XSS in injected HTML) ----------
export const esc = (str) => {
  if (str == null) return '';
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
};

// ---------- Toast ----------
export function toast(message, type = 'info', duration = 4000) {
  const container = $('#toasts');
  if (!container) return;
  const icons = {
    success: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    error:   '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    info:    '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="8"/></svg>',
  };
  const el = h('div', { class: `toast ${type}`, html: `${icons[type] || icons.info}<div class="toast-msg">${esc(message)}</div><button class="toast-x" aria-label="Dismiss">✕</button>` });
  const remove = () => { el.style.opacity = '0'; el.style.transform = 'translateX(20px)'; setTimeout(() => el.remove(), 260); };
  el.querySelector('.toast-x').addEventListener('click', remove);
  if (duration > 0) setTimeout(remove, duration);
  container.appendChild(el);
}

// ---------- Modal ----------
let _modalActive = null;
export function closeModal() {
  if (_modalActive && typeof _modalActive._close === 'function') _modalActive._close();
}
export function openModal(content, opts = {}) {
  const { size = '', closable = true, onClose } = opts;
  const root = $('#modal-root');
  root.innerHTML = '';
  const inner = h('div', { class: `content glass ${size}` },
    closable && h('button', { class: 'close', 'aria-label': 'Close', html: '✕' }),
    content,
  );
  const backdrop = h('div', { class: 'backdrop' });
  const m = h('div', { class: 'modal open' });
  m.appendChild(backdrop);
  m.appendChild(inner);
  root.appendChild(m);
  let _closing = false;
  const close = () => {
    if (_closing) return; _closing = true;
    m.classList.remove('open');
    setTimeout(() => { m.remove(); _modalActive = null; if (typeof onClose === 'function') onClose(); }, var_dur());
  };
  if (closable) {
    inner.querySelector('.close').addEventListener('click', close);
    backdrop.addEventListener('click', close);
  }
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape' && _modalActive === m) { close(); document.removeEventListener('keydown', onKey); }
  });
  _modalActive = m;
  document.body.style.overflow = 'hidden';
  m._close = close;
  return { root: m, close };
}
function var_dur() { return 200; }

// ---------- Code block (with copy button) ----------
export function codeblock(text, lang = 'js', opts = {}) {
  const id = 'cb-' + Math.random().toString(36).slice(2);
  const container = h('div', { class: 'codeblock' },
    h('div', { class: 'header' },
      h('span', { class: 'lang' }, lang),
      h('button', { class: 'copy-btn', type: 'button', dataset: { copy: id } }, '⧉ Copy'),
    ),
    h('pre', { id }, String(text)),
  );
  // We attach handlers in app.js via event delegation to support markdown flows.
  return container;
}

// ---------- Animated count up ----------
export function countUp(el, target, duration = 700) {
  if (typeof target !== 'number') target = Number(target) || 0;
  const start = performance.now();
  const start_val = Number(el.textContent) || 0;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 1000 / 16;
  const step = (t) => {
    const p = Math.min(1, (t - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    const val = Math.round(start_val + (target - start_val) * eased);
    el.textContent = val.toLocaleString();
    if (p < 1) requestAnimationFrame(step);
    else el.textContent = target.toLocaleString();
  };
  if (reduce) { el.textContent = target.toLocaleString(); return; }
  requestAnimationFrame(step);
}

// ---------- JSON Tree (compact div-based renderer) ----------
export function jsonTree(obj, opts = {}) {
  const walk = (v) => {
    if (v === null) return h('span', { class: 'jt-null' }, 'null');
    if (typeof v === 'boolean') return h('span', { class: 'jt-bool' }, String(v));
    if (typeof v === 'number') return h('span', { class: 'jt-num' }, String(v));
    if (typeof v === 'string') {
      const isUrl = v.startsWith('http') && v.length < 280;
      if (isUrl) return h('a', { class: 'jt-str', href: v, target: '_blank', rel: 'noopener' }, `"${v}"`);
      return h('span', { class: 'jt-str' }, `"${esc(v)}"`);
    }
    if (Array.isArray(v)) {
      if (v.length === 0) return h('span', { class: 'jt-empty' }, '[]');
      const ul = h('div', { class: 'jt-arr' });
      v.forEach((item) => ul.appendChild(h('div', { class: 'jt-item' }, walk(item))));
      return ul;
    }
    if (typeof v === 'object') {
      const keys = Object.keys(v);
      if (keys.length === 0) return h('span', { class: 'jt-empty' }, '{}');
      const ul = h('div', { class: 'jt-obj' });
      keys.forEach((k) => ul.appendChild(h('div', { class: 'jt-item' },
        h('span', { class: 'jt-key' }, esc(k)),
        h('span', { class: 'jt-colon' }, ': '),
        walk(v[k]),
      )));
      return ul;
    }
    return h('span', {}, String(v));
  };
  const root = h('div', { class: `jt ${opts.class || ''}` }, walk(obj));
  // Inject scoped CSS once
  if (!document.getElementById('jt-css')) {
    const css = document.createElement('style');
    css.id = 'jt-css';
    css.textContent = `
    .jt{font-family:var(--font-mono);font-size:var(--fs-xs);line-height:1.55;color:var(--color-text-1);overflow-x:auto}
    .jt-key{color:var(--color-accent)}
    .jt-str{color:var(--color-emerald)}
    .jt-str a{color:var(--color-emerald);text-decoration:underline dashed rgba(var(--emerald-rgb),0.4)}
    .jt-str a:hover{text-decoration:underline solid}
    .jt-num{color:var(--amber)}
    .jt-bool{color:var(--color-sky)}
    .jt-null{color:var(--color-text-3);font-style:italic}
    .jt-obj,.jt-arr{margin-left:14px;border-left:1px dashed rgba(var(--glass-border));padding-left:8px}
    .jt-item{margin:2px 0}
    .jt-empty{color:var(--color-text-3)}
    .jt-colon{color:var(--color-text-3)}`;
    document.head.appendChild(css);
  }
  return root;
}

// ---------- Copy to clipboard ----------
export async function copyText(text, onError) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch {
      if (typeof onError === 'function') onError();
      return false;
    }
  }
}

// ---------- Skeleton row ----------
export function skeleton(count = 1, height = 24) {
  const wrap = h('div', { class: 'stack-2' });
  for (let i = 0; i < count; i++) wrap.appendChild(h('div', { class: 'skeleton', style: { height: `${height}px` } }));
  return wrap;
}

// ---------- Empty state ----------
export function emptyState(title, subtitle, icon = null, actionText = null, onAction = null) {
  const iconEl = icon || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M9 9.5h.01M15 9.5h.01M8 15a4 4 0 0 1 8 0"/></svg>';
  const el = h('div', { class: 'empty-state', html: iconEl });
  el.appendChild(h('h3', {}, title));
  if (subtitle) el.appendChild(h('p', {}, subtitle));
  if (actionText && onAction) {
    const btn = h('button', { class: 'btn primary tonal', type: 'button' }, actionText);
    btn.addEventListener('click', onAction);
    el.appendChild(h('div', { style: { marginTop: '12px' } }, btn));
  }
  return el;
}

// ---------- Ripple effect (added globally) ----------
export function attachRipple(root = document) {
  root.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.btn');
    if (!btn || btn.disabled) return;
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    btn.appendChild(ripple);
    setTimeout(() => ripple.remove(), 260);
  });
}

// ---------- JSON validity checker (live) ----------
export function attachLiveValidation(field) {
  const input = field.querySelector('input, textarea, [data-json-input]');
  if (!input) return;
  const badge = field.querySelector('.validity');
  if (!badge) return;
  const validate = () => {
    const v = (input.value || '').trim();
    if (!v) { badge.textContent = ''; badge.classList.remove('ok', 'bad'); input.classList.remove('error'); return; }
    try { JSON.parse(v); badge.textContent = '✓ valid'; badge.classList.add('ok'); badge.classList.remove('bad'); input.classList.remove('error'); }
    catch { badge.textContent = '✗ invalid'; badge.classList.add('bad'); badge.classList.remove('ok'); input.classList.remove('error'); }
  };
  input.addEventListener('input', validate);
  validate();
}

// ---------- Activate codeblock copy buttons (called once at boot) ----------
export function wireCopyButtons(root = document) {
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const source = document.getElementById(btn.dataset.copy);
    if (!source) return;
    const ok = await copyText(source.textContent);
    if (ok) {
      btn.classList.add('copied');
      const original = btn.textContent;
      btn.textContent = '✓ Copied';
      setTimeout(() => { btn.classList.remove('copied'); btn.textContent = original; }, 1600);
    }
  });
}

// ---------- Theme controller ----------
export const Theme = {
  current() { return document.documentElement.dataset.theme || 'dark'; },
  set(theme) {
    document.documentElement.dataset.theme = theme;
    $('#theme-toggle').dataset.active = theme;
    $$('.theme-toggle .seg').forEach((s) => s.classList.toggle('active', s.dataset.themeVal === theme));
    try { localStorage.setItem('pg-theme', theme); } catch {}
  },
  init() {
    let theme = localStorage.getItem('pg-theme');
    if (!theme) {
      const prefersLight = matchMedia('(prefers-color-scheme: light)').matches;
      theme = prefersLight ? 'light' : 'dark';
    }
    this.set(theme);
  },
};
