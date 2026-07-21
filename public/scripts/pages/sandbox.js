// pages/sandbox.js — Sandbox playground: live request/response test against /sandbox/test,
// browse ./sandboxes/*.js files, see trace timeline.
import { h, esc, toast, codeblock, jsonTree, emptyState, skeleton, $ } from '../components.js';
import { Sandbox, Providers } from '../api.js';

const SAMPLE_REQ = JSON.stringify({
  model: 'gm:gemini-2.5-pro',
  messages: [{ role: 'user', content: 'Say hello.' }],
  stream: true,
  temperature: 0.7,
}, null, 2);

const SAMPLE_UPSTREAM_BODY = JSON.stringify({
  candidates: [{ content: { parts: [{ text: 'Hello!' }] } }],
}, null, 2);

let _files = null;
let _providers = {};
let _phase = 'request';
let _loading = false;

export async function renderSandbox(root) {
  root.appendChild(h('div', { class: 'page-head' },
    h('h1', { html: '<b>Sandbox</b> Playground' }),
    h('div', { class: 'actions' },
      h('span', { class: 'chip tonal', style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } },
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
        'Universal Contract',
      ),
      h('a', { class: 'btn ghost', href: '#help', html: '📖 Reference' }),
    ),
  ));

  const card = h('div', { class: 'glass card' });
  root.appendChild(card);

  // Tabs: request vs response
  const tabs = h('div', { class: 'tabstrip', role: 'tablist', style: { marginBottom: '16px' } });
  card.appendChild(tabs);
  tabs.appendChild(makeTab('Request phase', _phase === 'request', () => setPhase('request'), 'request', tabs));
  tabs.appendChild(makeTab('Response phase', _phase === 'response', () => setPhase('response'), 'response', tabs));

  // 2-col split: left = inputs, right = outputs
  const grid = h('div', { class: 'bento', style: { alignItems: 'stretch' } });
  card.appendChild(grid);

  const leftCol = h('div', { style: { gridColumn: 'span 6' } });
  const rightCol = h('div', { style: { gridColumn: 'span 6' } });
  grid.appendChild(leftCol);
  grid.appendChild(rightCol);

  // — Left: code + inputs —
  // Input source dropdown: code (custom) | filename (from sandboxes/) | provider-owned
  const sourceBar = h('div', { class: 'row tight', style: { marginBottom: '10px' } },
    h('select', { id: 'sb-source', style: { width: 'auto', minWidth: '180px' } },
      h('option', { value: 'code' }, 'Paste code'),
      h('option', { value: 'filename' }, 'From ./sandboxes/'),
      h('option', { value: 'provider' }, 'By provider'),
    ),
    h('select', { id: 'sb-source-target', style: { flex: 1, display: 'none' } }),
  );
  leftCol.appendChild(sourceBar);

  const codeEditor = h('textarea', { id: 'sb-code', rows: '14', placeholder: 'module.exports = { universal: true, request(s) { return { body: s.req } } }', style: { fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' } });
  leftCol.appendChild(codeEditor);

  const inputsHeader = h('div', { class: 'section-divider', style: { marginTop: '16px' } }, 'Inputs');
  leftCol.appendChild(inputsHeader);

  const requestInputs = h('div', { id: 'sb-request-inputs' });
  const responseInputs = h('div', { id: 'sb-response-inputs', style: { display: 'none' } });
  leftCol.appendChild(requestInputs);
  leftCol.appendChild(responseInputs);
  requestInputs.appendChild(fieldArea('Request body (JSON)', 'sb-req', SAMPLE_REQ, 12));
  requestInputs.appendChild(fieldArea('Path', 'sb-path', '/v1/chat/completions', 1));
  requestInputs.appendChild(fieldArea('Allowed hosts (comma-separated)', 'sb-hosts', '', 1));

  responseInputs.appendChild(fieldArea('Request body (JSON)', 'sb-res-req', SAMPLE_REQ, 6));
  responseInputs.appendChild(fieldArea('Upstream status', 'sb-res-status', '200', 1));
  responseInputs.appendChild(fieldArea('Upstream Content-Type', 'sb-res-ct', 'application/json', 1));
  responseInputs.appendChild(fieldArea('Upstream body', 'sb-res-body', SAMPLE_UPSTREAM_BODY, 12));

  const allowedHostsInput = () => $('#sb-hosts')?.value.split(',').map((s) => s.trim()).filter(Boolean);

  const runBtn = h('button', { class: 'btn primary', id: 'sb-run-btn', type: 'button', style: { marginTop: '12px' }, html: '▶ Run' });
  leftCol.appendChild(runBtn);

  // — Right: output —
  rightCol.appendChild(h('div', { class: 'section-divider' }, 'Output'));
  const outCard = h('div', { class: 'glass card-pad-sm', id: 'sb-output', style: { background: 'rgba(var(--bg-0), 0.45)', minHeight: '420px' } });
  outCard.appendChild(emptyState('Run a test', 'Run the sandbox phase to see output and trace.', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>'));
  rightCol.appendChild(outCard);

  // — Files browser below —
  const filesCard = h('div', { class: 'glass card', style: { marginTop: '20px' } });
  root.appendChild(filesCard);
  filesCard.appendChild(h('h3', { style: { marginBottom: '12px' } }, '📁 ./sandboxes/*.js'));
  const filesList = h('div', { id: 'sb-files', class: 'stack-2' });
  filesCard.appendChild(filesList);
  filesList.appendChild(skeleton(3, 30));

  // Wire event handlers
  sourceBar.querySelector('#sb-source').addEventListener('change', async (e) => {
    const v = e.target.value;
    const tgt = sourceBar.querySelector('#sb-source-target');
    tgt.innerHTML = '';
    if (v === 'code') {
      tgt.style.display = 'none';
      codeEditor.disabled = false;
      return;
    }
    tgt.style.display = '';
    codeEditor.disabled = false;
    if (v === 'filename') {
      // Populate from _files
      if (!_files) {
        try {
          const r = await Sandbox.files();
          _files = (r && r.files) || [];
        } catch (e) {
          _files = [];
          toast(e.message || 'Failed to list sandbox files', 'error');
        }
      }
      _files.forEach((f) => tgt.appendChild(h('option', { value: f }, f)));
    } else if (v === 'provider') {
      Object.entries(_providers).forEach(([prefix, p]) => {
        if (p.sandbox_code || p.sandbox_file) tgt.appendChild(h('option', { value: prefix }, `${p.name || prefix} (${prefix})`));
      });
    }
  });

  sourceBar.querySelector('#sb-source-target').addEventListener('change', async (e) => {
    const v = e.target.value;
    const mode = sourceBar.querySelector('#sb-source').value;
    if (!v) return;
    try {
      let code = '';
      if (mode === 'filename') code = await Sandbox.file(v);
      else if (mode === 'provider') {
        const p = _providers[v];
        if (!p) return;
        if (p.sandbox_code) code = p.sandbox_code;
        else if (p.sandbox_file) code = await Sandbox.file(p.sandbox_file);
      }
      codeEditor.value = code;
      toast(`Loaded ${v}`, 'info', 1500);
    } catch (e) {
      toast(e.message || 'Could not load source', 'error');
    }
  });

  setPhase(_phase);

  function setPhase(phase) {
    _phase = phase;
    // Swap inputs
    requestInputs.style.display = phase === 'request' ? '' : 'none';
    responseInputs.style.display = phase === 'response' ? '' : 'none';
    runBtn.textContent = phase === 'request' ? '▶ Run Request Phase' : '▶ Run Response Phase';
    [...tabs.children].forEach((tab) => tab.classList.toggle('active', tab.dataset.phase === phase));
  }

  runBtn.addEventListener('click', async () => {
    if (_loading) return;
    outCard.innerHTML = '';
    outCard.appendChild(skeleton(2, 200));
    runBtn.disabled = true;
    _loading = true;
    try {
      const source = sourceBar.querySelector('#sb-source').value;
      let code = codeEditor.value.trim();
      let filename;
      let provider;
      if (source === 'filename') {
        filename = sourceBar.querySelector('#sb-source-target').value;
        code = '';
      } else if (source === 'provider') {
        provider = sourceBar.querySelector('#sb-source-target').value;
        code = '';
      }
      if (!code && !filename && !provider) {
        outCard.innerHTML = '';
        outCard.appendChild(emptyState('No code to run', 'Paste code above, or pick a file/provider as source.', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><line x1="8" y1="8" x2="16" y2="16"/></svg>'));
        return;
      }

      let result;
      if (_phase === 'request') {
        const reqBody = parseJSON($('#sb-req').value, {});
        const body = {
          code, filename, provider,
          req: reqBody,
          path: $('#sb-path').value || '/v1/chat/completions',
          allowed_hosts: allowedHostsInput(),
          stream: !!reqBody.stream,
        };
        result = await Sandbox.test(body);
      } else {
        const reqBody = parseJSON($('#sb-res-req').value, {});
        const body = {
          code, filename, provider,
          req: reqBody,
          upstreamStatus: Number($('#sb-res-status').value) || 200,
          upstreamContentType: $('#sb-res-ct').value || 'application/json',
          upstreamBody: $('#sb-res-body').value,
        };
        result = await Sandbox.testResponse(body);
      }
      renderOutput(outCard, result);
    } catch (e) {
      outCard.innerHTML = '';
      outCard.append(errorCard(e.message || 'Test failed'));
    } finally {
      _loading = false;
      runBtn.disabled = false;
    }
  });

  // Initial load files + providers
  try {
    const [f, p] = await Promise.all([Sandbox.files().catch(() => ({ files: [] })), Providers.list()]);
    _files = (f && f.files) || [];
    _providers = p || {};
    renderFiles();
  } catch (e) {
    toast(e.message || 'Could not load files/providers', 'error');
  }

  function renderFiles() {
    filesList.innerHTML = '';
    if (!_files.length) {
      filesList.appendChild(emptyState('No sandbox files yet', 'Put .js files in ./sandboxes/ on the server. They hot-reload automatically.', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 6h18M3 12h18M3 18h18"/></svg>'));
      return;
    }
    _files.forEach((f) => {
      const row = h('div', { class: 'list-row' },
        h('span', { class: 'prefix' }, 'JS'),
        h('span', { class: 'id' }, esc(f)),
        h('span', { class: 'copy-tip' }, '⇄ Load'),
      );
      row.addEventListener('click', async () => {
        const sb = sourceBar.querySelector('#sb-source');
        const tgt = sourceBar.querySelector('#sb-source-target');
        sb.value = 'filename';
        // Trigger change handler — it will populate the dropdown with all files
        // from _files, then set the value, then re-dispatch change on target.
        sb.dispatchEvent(new Event('change'));
        tgt.value = f;
        tgt.dispatchEvent(new Event('change'));
        toast('Loaded ' + f, 'info', 1500);
        // scroll to top
        root.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      filesList.appendChild(row);
    });
  }
}

function renderOutput(container, result) {
  container.innerHTML = '';
  if (result.error) {
    container.append(errorCard(result.error));
    return;
  }
  const out = result.request || result.response || result;
  const trace = Array.isArray(result.trace) ? result.trace : [];

  // Trace timeline
  if (trace.length) {
    const tcard = h('div', { style: { marginBottom: '16px' } });
    tcard.appendChild(h('div', { class: 'section-divider', style: { marginTop: '0' } }, 'Trace', h('span', { class: 'hint' }, `${trace.length} steps`)));
    const chips = h('div', { class: 'row wrap', style: { gap: '6px' } });
    trace.forEach((step, i) => {
      const phase = step.phase || step.name || 'step';
      const dur = step.ms != null ? ` · ${step.ms}ms` : '';
      const chip = h('span', { class: 'chip', style: { fontSize: 'var(--fs-2xs)', fontFamily: 'var(--font-mono)' } },
        (i + 1) + ' · ' + phase + dur,
      );
      chips.appendChild(chip);
    });
    tcard.appendChild(chips);
    const traceDetail = h('div', { class: 'codeblock', style: { marginTop: '10px' } });
    traceDetail.appendChild(h('div', { class: 'header' }, h('span', { class: 'lang' }, 'trace')));
    traceDetail.appendChild(h('pre', { html: esc(JSON.stringify(trace, null, '  ')) }));
    tcard.appendChild(traceDetail);
    container.appendChild(tcard);
  }

  // Output tree
  container.appendChild(h('div', { class: 'section-divider', style: { marginTop: '16px' } }, 'Result'));
  try {
    container.appendChild(jsonTree(out));
  } catch (e) {
    container.appendChild(h('pre', {}, esc(JSON.stringify(out, null, 2))));
  }
}

function errorCard(msg) {
  return h('div', { class: 'glass', style: { padding: '16px', border: '1px solid rgba(var(--rose), 0.4)', background: 'rgba(var(--rose-soft))', borderRadius: 'var(--r-md)' } },
    h('div', { class: 'row tight', style: { gap: '8px' } },
      h('span', { style: { color: 'var(--color-rose)', fontWeight: '700' } }, '✕ Error'),
    ),
    h('pre', { style: { marginTop: '8px', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' } }, esc(String(msg))),
  );
}

function parseJSON(text, dflt) {
  try { return JSON.parse(text); } catch { return dflt; }
}

function fieldArea(label, id, value, rows = 4) {
  const wrap = h('div', { class: 'field', style: { marginBottom: '12px' } });
  wrap.appendChild(h('label', { for: id }, label));
  wrap.appendChild(h('textarea', { id, rows: String(rows), style: { fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' } }, String(value || '')));
  return wrap;
}

function makeTab(label, isActive, onClick, phase, parent) {
  const btn = h('button', {
    class: `tab ${isActive ? 'active' : ''}`,
    type: 'button',
    dataset: { phase },
    onclick: () => { onClick(); },
  }, label);
  return btn;
}
