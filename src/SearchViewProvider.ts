import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { ISearchResult } from './types';
import { getConnection } from './IrisConnectionService';
import { search } from './IrisSearchService';

export class SearchViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ObjectScriptSearch';

  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
    };

    webviewView.webview.html = this._buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      switch (msg.type) {
        case 'search':
          await this._handleSearch(msg.query, msg.categories);
          break;
        case 'openFile':
          await this._openFile(msg.name, msg.category);
          break;
      }
    });
  }

  // ---------------------------------------------------------------------------

  private async _handleSearch(
    query: string,
    categories: string[],
  ): Promise<void> {
    if (!this._view) {
      return;
    }

    this._post({ type: 'loading', loading: true });

    try {
      const connection = await getConnection();
      if (!connection) {
        this._post({
          type: 'error',
          message:
            'No active ObjectScript connection found.\n\n' +
            'Add a server in "intersystems.servers" and set "objectscript.conn" in your workspace settings.',
        });
        return;
      }

      const cfg = vscode.workspace.getConfiguration('objectscriptSearch');
      const maxResults = cfg.get<number>('maxResults', 100);
      const includeSystem = cfg.get<boolean>('includeSystem', false);

      const opts = {
        query,
        categories: categories as import('./types').DocCategory[],
        maxResults,
        includeSystem,
      };

      const results = await search(connection, opts);

      this._post({ type: 'results', results, serverInfo: connection.serverName ?? connection.host });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._post({ type: 'error', message });
    } finally {
      this._post({ type: 'loading', loading: false });
    }
  }

  private async _openFile(name: string, _category: string): Promise<void> {
    const connection = await getConnection();
    if (!connection) {
      vscode.window.showErrorMessage('ObjectScript Search: no active connection to open file.');
      return;
    }

    // Construct isfs:// URI understood by vscode-objectscript
    // Format: isfs://<serverName>:<namespace>/<docPath>
    const serverPart = connection.serverName
      ? `${connection.serverName}:${connection.namespace.toLowerCase()}`
      : `${connection.host}:${connection.port}/${connection.namespace.toLowerCase()}`;

    const uri = vscode.Uri.parse(`isfs://${serverPart}/${name}`);

    try {
      await vscode.commands.executeCommand('vscode.open', uri);
    } catch {
      vscode.window.showWarningMessage(
        `Cannot open "${name}". Make sure the vscode-objectscript extension is active and the server-side workspace folder is open.`,
      );
    }
  }

  private _post(message: Record<string, unknown>): void {
    this._view?.webview.postMessage(message);
  }

  // ---------------------------------------------------------------------------

  private _buildHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ObjectScript Search</title>
  <style nonce="${nonce}">
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 8px 8px 16px;
    }

    /* ── Search bar ─────────────────────────────────────────────────────── */
    .row {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-bottom: 6px;
    }

    .input-wrap {
      flex: 1;
      display: flex;
      align-items: center;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      padding: 2px 6px;
    }

    .input-wrap:focus-within {
      border-color: var(--vscode-focusBorder);
    }

    #query {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--vscode-input-foreground);
      font: inherit;
      outline: none;
      padding: 3px 0;
    }

    #query::placeholder { color: var(--vscode-input-placeholderForeground); }

    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      padding: 4px 12px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-primary:disabled { opacity: 0.5; cursor: default; }

    /* ── Toggle pills ───────────────────────────────────────────────────── */
    .options { margin-bottom: 6px; display: flex; flex-direction: column; gap: 4px; }

    .opt-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; }

    .opt-label {
      color: var(--vscode-descriptionForeground);
      min-width: 52px;
    }

    .pills { display: flex; gap: 3px; flex-wrap: wrap; }

    .pill {
      background: transparent;
      border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, var(--vscode-widget-border, #555)));
      color: var(--vscode-foreground);
      border-radius: 10px;
      padding: 1px 8px;
      font: inherit;
      font-size: 11px;
      cursor: pointer;
      opacity: 0.55;
      transition: opacity 0.1s;
    }
    .pill:hover { opacity: 0.85; }
    .pill.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: transparent;
      opacity: 1;
    }

    /* ── Separator & status ─────────────────────────────────────────────── */
    hr { border: none; border-top: 1px solid var(--vscode-sideBarSectionHeader-border, #333); margin: 8px 0; }

    .status {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      min-height: 16px;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .spinner {
      display: none;
      width: 10px; height: 10px;
      border: 2px solid var(--vscode-progressBar-background, #0e70c0);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.65s linear infinite;
      flex-shrink: 0;
    }
    .loading .spinner { display: block; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Results: grouped by file, VS Code style ───────────────────────── */
    .file-group { margin-bottom: 2px; }

    .file-header {
      display: flex;
      align-items: center;
      padding: 3px 4px;
      border-radius: 2px;
      cursor: pointer;
      gap: 5px;
      font-size: 12px;
      font-weight: 600;
    }
    .file-header:hover { background: var(--vscode-list-hoverBackground); }

    .file-header .result-badge { flex-shrink: 0; }

    .file-name {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .match-count {
      flex-shrink: 0;
      font-size: 10px;
      font-weight: 400;
      color: var(--vscode-descriptionForeground);
      padding: 1px 6px;
      border-radius: 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .match-list {
      list-style: none;
      margin-left: 22px;
      border-left: 1px solid var(--vscode-tree-indentGuidesStroke, #555);
    }

    .match-item {
      display: flex;
      align-items: baseline;
      gap: 6px;
      padding: 2px 8px;
      cursor: pointer;
      border-radius: 2px;
      font-size: 11px;
    }
    .match-item:hover { background: var(--vscode-list-hoverBackground); }

    .match-loc {
      flex-shrink: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      min-width: 30px;
      text-align: right;
    }

    .match-text {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--vscode-foreground);
    }

    /* ── Error / empty ──────────────────────────────────────────────────── */
    .error {
      padding: 8px;
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground));
      border-radius: 2px;
      font-size: 12px;
      white-space: pre-wrap;
    }

    .empty {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      padding: 20px 8px;
    }

    mark {
      background: var(--vscode-editor-findMatchHighlightBackground, #9e6a03);
      color: inherit;
      border-radius: 1px;
    }

    .result-badge {
      flex-shrink: 0;
      width: 18px; height: 18px;
      border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 9px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
    }
  </style>
</head>
<body>

  <div class="row">
    <div class="input-wrap">
      <input id="query" type="text" placeholder="Search on IRIS…" autocomplete="off" spellcheck="false" />
    </div>
    <button class="btn-primary" id="searchBtn">Search</button>
  </div>

  <div class="options">
    <div class="opt-row">
      <span class="opt-label">Types:</span>
      <div class="pills" id="typeGroup">
        <button class="pill active" data-value="CLS">Classes</button>
        <button class="pill active" data-value="RTN">Routines</button>
        <button class="pill active" data-value="INC">Includes</button>
        <button class="pill" data-value="CSP">Web</button>
      </div>
    </div>
  </div>

  <hr>

  <div class="status" id="status">
    <div class="spinner" id="spinner"></div>
    <span id="statusText"></span>
  </div>

  <div id="results"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  let categories = ['CLS', 'RTN', 'INC'];
  let lastQuery = '';

  const queryEl   = document.getElementById('query');
  const searchBtn = document.getElementById('searchBtn');
  const statusEl  = document.getElementById('status');
  const statusTxt = document.getElementById('statusText');
  const resultsEl = document.getElementById('results');

  // ── Toggle pills ─────────────────────────────────────────────────────────

  function setupPillGroup(groupId, multi, onChange) {
    const group = document.getElementById(groupId);
    group.addEventListener('click', (e) => {
      const pill = e.target.closest('.pill');
      if (!pill) return;
      if (multi) {
        pill.classList.toggle('active');
      } else {
        group.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
      }
      onChange();
    });
  }

  setupPillGroup('typeGroup', true, () => {
    categories = Array.from(document.querySelectorAll('#typeGroup .pill.active'))
      .map(p => p.dataset.value);
  });

  // ── Search ───────────────────────────────────────────────────────────────

  function doSearch() {
    const q = queryEl.value.trim();
    if (!q) return;
    lastQuery = q;
    vscode.postMessage({ type: 'search', query: q, categories });
  }

  searchBtn.addEventListener('click', doSearch);
  queryEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  // ── Message handler ───────────────────────────────────────────────────────

  window.addEventListener('message', ({ data: msg }) => {
    switch (msg.type) {
      case 'loading':
        setLoading(msg.loading);
        break;
      case 'results':
        showResults(msg.results, msg.serverInfo);
        break;
      case 'error':
        showError(msg.message);
        break;
    }
  });

  function setLoading(loading) {
    searchBtn.disabled = loading;
    statusEl.classList.toggle('loading', loading);
    if (loading) {
      statusTxt.textContent = 'Searching…';
      resultsEl.innerHTML = '';
    }
  }

  function showResults(results, serverInfo) {
    resultsEl.innerHTML = '';
    if (!results.length) {
      statusTxt.textContent = lastQuery ? 'No results.' : '';
      const d = document.createElement('div');
      d.className = 'empty';
      d.textContent = lastQuery ? 'No documents matched your query.' : '';
      resultsEl.appendChild(d);
      return;
    }

    const totalMatches = results.reduce((n, r) => n + (r.matches ? r.matches.length : 0), 0);
    const limit = totalMatches >= 200 ? ' (limit reached)' : '';
    statusTxt.textContent =
      totalMatches + (totalMatches === 1 ? ' match' : ' matches')
      + ' in ' + results.length + (results.length === 1 ? ' file' : ' files')
      + limit
      + (serverInfo ? ' · ' + serverInfo : '');

    for (const r of results) {
      const group = document.createElement('div');
      group.className = 'file-group';

      // ── File header ──────────────────────────────────────────────────────
      const header = document.createElement('div');
      header.className = 'file-header';
      header.title = r.name;
      header.dataset.name = r.name;
      header.dataset.category = r.category;

      const badge = document.createElement('div');
      badge.className = 'result-badge';
      badge.textContent = badgeText(r.category);

      const nameEl = document.createElement('span');
      nameEl.className = 'file-name';
      nameEl.textContent = r.name;

      const countEl = document.createElement('span');
      countEl.className = 'match-count';
      const mc = r.matches ? r.matches.length : 0;
      countEl.textContent = mc + (mc === 1 ? ' match' : ' matches');

      header.appendChild(badge);
      header.appendChild(nameEl);
      header.appendChild(countEl);
      header.addEventListener('click', () =>
        vscode.postMessage({ type: 'openFile', name: r.name, category: r.category }),
      );
      group.appendChild(header);

      // ── Match list ───────────────────────────────────────────────────────
      if (r.matches && r.matches.length) {
        const list = document.createElement('ul');
        list.className = 'match-list';

        for (const m of r.matches) {
          const li = document.createElement('li');
          li.className = 'match-item';

          const loc = document.createElement('span');
          loc.className = 'match-loc';
          loc.textContent = m.member || m.line || '';

          const text = document.createElement('span');
          text.className = 'match-text';
          text.innerHTML = highlight(esc(m.text.trim()), lastQuery);

          li.appendChild(loc);
          li.appendChild(text);
          li.addEventListener('click', () =>
            vscode.postMessage({ type: 'openFile', name: r.name, category: r.category }),
          );
          list.appendChild(li);
        }
        group.appendChild(list);
      }

      resultsEl.appendChild(group);
    }
  }

  function showError(message) {
    resultsEl.innerHTML = '';
    statusTxt.textContent = '';
    const div = document.createElement('div');
    div.className = 'error';
    div.textContent = message;
    resultsEl.appendChild(div);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function badgeText(cat) {
    const map = { CLS: 'C', MAC: 'M', INT: 'I', INC: '#', PKG: 'P', CSP: 'W', RTN: 'R' };
    return map[(cat || '').toUpperCase()] || '?';
  }

  function esc(t) {
    return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function highlight(escapedText, query) {
    if (!query) return escapedText;
    // Case-insensitive highlight using index-based loop to avoid regex metachar issues
    const eq = esc(query);
    const lower = escapedText.toLowerCase();
    const lowerQ = eq.toLowerCase();
    const parts = [];
    let start = 0;
    let idx;
    while ((idx = lower.indexOf(lowerQ, start)) !== -1) {
      parts.push(escapedText.slice(start, idx));
      parts.push('<mark>' + escapedText.slice(idx, idx + eq.length) + '</mark>');
      start = idx + eq.length;
    }
    parts.push(escapedText.slice(start));
    return parts.join('');
  }
</script>
</body>
</html>`;
  }
}

// ---------------------------------------------------------------------------
// Types for messages received from the webview
// ---------------------------------------------------------------------------

type WebviewMessage =
  | { type: 'search'; query: string; categories: string[] }
  | { type: 'openFile'; name: string; category: string };
