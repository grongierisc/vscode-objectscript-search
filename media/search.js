/* global acquireVsCodeApi */
(function () {
  'use strict';

  // acquireVsCodeApi is injected by VS Code's webview runtime
  const vscode = acquireVsCodeApi();
  const S = vscode.getState() || {};

  /** @type {boolean} */ let C = S.C || false;
  /** @type {boolean} */ let W = S.W || false;
  /** @type {boolean} */ let R = S.R || false;
  /** @type {string[]} */ let cats = S.cats || ['CLS', 'RTN', 'INC'];
  /** @type {boolean} */ let sys = S.sys || false;
  /** @type {boolean} */ let gen = S.gen || false;
  /** @type {string} */  let lastQ = '';

  const q      = /** @type {HTMLInputElement}    */ (document.getElementById('q'));
  const bc     = /** @type {HTMLButtonElement}   */ (document.getElementById('bc'));
  const bw     = /** @type {HTMLButtonElement}   */ (document.getElementById('bw'));
  const br     = /** @type {HTMLButtonElement}   */ (document.getElementById('br'));
  const bf     = /** @type {HTMLButtonElement}   */ (document.getElementById('bf'));
  const status = /** @type {HTMLDivElement}      */ (document.getElementById('status'));
  const results= /** @type {HTMLDivElement}      */ (document.getElementById('results'));
  const warn   = /** @type {HTMLDivElement}      */ (document.getElementById('warn'));
  const fsum   = /** @type {HTMLSpanElement}     */ (document.getElementById('fsum'));

  // ── State helpers ──────────────────────────────────────────────────────────

  function syncToggles() {
    bc.classList.toggle('on', C);
    bw.classList.toggle('on', W);
    br.classList.toggle('on', R);
  }

  function syncFilterSummary() {
    /** @type {Record<string, string>} */
    const L = { CLS: 'Classes', RTN: 'Routines', INC: 'Includes', CSP: 'Web' };
    const parts = (cats.length ? cats : ['CLS', 'RTN', 'INC']).map(c => L[c] || c);
    if (sys) { parts.push('System'); }
    if (gen) { parts.push('Generated'); }
    fsum.textContent = parts.join(' · ');
  }

  function save() { vscode.setState({ C, W, R, cats, sys, gen }); }

  function send() {
    const v = q.value.trim();
    if (!v) { return; }
    lastQ = v;
    vscode.postMessage({ type: 'search', query: v, matchCase: C, matchWord: W, useRegex: R });
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  syncToggles();
  syncFilterSummary();

  // ── Controls ───────────────────────────────────────────────────────────────

  bc.addEventListener('click', () => { C = !C; syncToggles(); save(); });
  bw.addEventListener('click', () => { W = !W; syncToggles(); save(); });
  br.addEventListener('click', () => { R = !R; syncToggles(); save(); });
  bf.addEventListener('click', () => vscode.postMessage({ type: 'showFilters', categories: cats, includeSystem: sys, includeGenerated: gen }));

  q.addEventListener('keydown', e => {
    if (e.key === 'Enter') { send(); return; }
    if (e.altKey) {
      if (e.key.toLowerCase() === 'c') { bc.click(); e.preventDefault(); }
      if (e.key.toLowerCase() === 'w') { bw.click(); e.preventDefault(); }
      if (e.key.toLowerCase() === 'r') { br.click(); e.preventDefault(); }
    }
  });

  // ── Messages from extension host ───────────────────────────────────────────

  window.addEventListener('message', ({ data: m }) => {
    switch (m.type) {
      case 'loading':
        if (m.loading) { status.textContent = 'Searching\u2026'; results.innerHTML = ''; }
        break;
      case 'appendResults':
        appendResults(m.results, m.serverInfo, m.totalFiles, m.totalMatches);
        break;
      case 'error': {
        results.innerHTML = '';
        const el = document.createElement('div');
        el.className = 'err';
        el.textContent = m.message;
        results.appendChild(el);
        status.textContent = '';
        break;
      }
      case 'connStatus':
        warn.style.display = m.ok ? 'none' : 'block';
        if (!m.ok) {
          warn.textContent = '\u26a0 No active ObjectScript connection.\nSet "objectscript.conn" in workspace settings and set active to true.';
        }
        break;
      case 'filtersUpdated':
        cats = m.categories.length ? m.categories : ['CLS', 'RTN', 'INC'];
        sys  = m.includeSystem;
        gen  = m.includeGenerated;
        syncFilterSummary();
        save();
        break;
      case 'requestFilters':
        vscode.postMessage({ type: 'showFilters', categories: cats, includeSystem: sys, includeGenerated: gen });
        break;
    }
  });

  // ── Result rendering ───────────────────────────────────────────────────────

  /**
   * @param {any[]} items
   * @param {string} serverInfo
   * @param {number} tf
   * @param {number} tm
   */
  function appendResults(items, serverInfo, tf, tm) {
    if (results.querySelector('.note')) { results.innerHTML = ''; }
    for (const r of items) { results.appendChild(buildFileGroup(r)); }
    if (tf === 0) {
      results.innerHTML = '<div class="note">No documents matched your query.</div>';
      status.textContent = '';
      return;
    }
    const suffix = tm >= 200 ? ' (limit reached)' : '';
    const srv = serverInfo ? ' · ' + serverInfo : '';
    status.textContent =
      tm + ' match' + (tm === 1 ? '' : 'es') +
      ' in ' + tf + ' file' + (tf === 1 ? '' : 's') +
      suffix + srv;
  }

  /** @param {any} r */
  function buildFileGroup(r) {
    const group = document.createElement('div');

    // file header row
    const header = document.createElement('div');
    header.className = 'fh';

    const icon = document.createElement('div');
    icon.className = 'fic';
    icon.textContent = categoryBadge(r.category);

    const name = document.createElement('span');
    name.className = 'fnm';
    name.textContent = r.name;

    const count = document.createElement('span');
    count.className = 'mc';
    count.textContent = String(r.matches?.length ?? 0);

    header.append(icon, name, count);
    header.addEventListener('click', () => vscode.postMessage({ type: 'openFile', name: r.name, category: r.category }));
    group.appendChild(header);

    // match rows
    for (const m of (r.matches || [])) {
      const row = document.createElement('div');
      row.className = 'mi';

      const lineNo = document.createElement('span');
      lineNo.className = 'ml';
      lineNo.textContent = String(m.line ?? m.attrline ?? m.member ?? '');

      const text = document.createElement('span');
      text.className = 'mt';
      text.innerHTML = highlight(escape(m.text.trim()), lastQ);

      row.append(lineNo, text);
      row.addEventListener('click', () => vscode.postMessage({
        type: 'openFile',
        name: r.name, category: r.category,
        member: m.member, line: m.line, attrline: m.attrline, attr: m.attr, text: m.text,
      }));
      group.appendChild(row);
    }

    return group;
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  /** @param {string} c */
  function categoryBadge(c) {
    return ({ CLS: 'C', MAC: 'M', INT: 'I', INC: '#', CSP: 'W', PKG: 'P', RTN: 'R' })[(c || '').toUpperCase()] || '?';
  }

  /** @param {string} t */
  function escape(t) {
    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * @param {string} text
   * @param {string} query
   */
  function highlight(text, query) {
    if (!query) { return text; }
    const escaped = escape(query);
    const tl = text.toLowerCase();
    const ql = escaped.toLowerCase();
    const parts = [];
    let i = 0, j;
    while ((j = tl.indexOf(ql, i)) !== -1) {
      parts.push(text.slice(i, j), '<mark>' + text.slice(j, j + escaped.length) + '</mark>');
      i = j + escaped.length;
    }
    parts.push(text.slice(i));
    return parts.join('');
  }
}());
