import * as vscode from 'vscode';
import type { ISearchResult, ISearchMatch, DocCategory, IConnection } from '../types';
import { getConnection, getAllConnections, NO_CONNECTION_MSG } from '../connection/IrisConnectionService';
import { SearchService } from './SearchService';

// ---------------------------------------------------------------------------
// Tree items
// ---------------------------------------------------------------------------

const CATEGORY_ICON: Record<string, string> = {
  CLS: 'symbol-class',
  MAC: 'symbol-misc',
  INT: 'symbol-misc',
  INC: 'file-symlink-file',
  CSP: 'globe',
  RTN: 'symbol-misc',
  PKG: 'symbol-namespace',
};

const CATEGORY_COLOR: Record<string, string> = {
  CLS: 'symbolIcon.classForeground',
  MAC: 'symbolIcon.miscForeground',
  INT: 'symbolIcon.miscForeground',
  INC: 'symbolIcon.fileForeground',
  CSP: 'charts.blue',
  RTN: 'symbolIcon.miscForeground',
  PKG: 'symbolIcon.namespaceForeground',
};

/**
 * Returns [start, end] highlight ranges for every non-overlapping occurrence
 * of `query` in `text`. Used to populate TreeItemLabel.highlights.
 */
function highlightRanges(text: string, query: string, matchCase: boolean): [number, number][] {
  if (!query) { return []; }
  const haystack = matchCase ? text        : text.toLowerCase();
  const needle   = matchCase ? query       : query.toLowerCase();
  const ranges: [number, number][] = [];
  let i = 0;
  while (i < haystack.length) {
    const j = haystack.indexOf(needle, i);
    if (j === -1) { break; }
    ranges.push([j, j + needle.length]);
    i = j + needle.length;
  }
  return ranges;
}

export class FileItem extends vscode.TreeItem {
  constructor(readonly result: ISearchResult, query: string, matchCase: boolean) {
    const text = result.name;
    const labelObj: vscode.TreeItemLabel = {
      label: text,
      highlights: highlightRanges(text, query, matchCase),
    };
    super(labelObj, vscode.TreeItemCollapsibleState.Expanded);
    const n = result.matches.length;
    this.description = `${n} match${n === 1 ? '' : 'es'}`;
    const color = CATEGORY_COLOR[result.category]
      ? new vscode.ThemeColor(CATEGORY_COLOR[result.category])
      : undefined;
    this.iconPath = new vscode.ThemeIcon(CATEGORY_ICON[result.category] ?? 'file', color);
    this.tooltip = result.name;
    this.contextValue = 'searchFile';
    this.command = {
      command: 'objectscriptSearch.openFile',
      title: 'Open',
      arguments: [result.name, result.category],
    };
  }
}

export class MatchItem extends vscode.TreeItem {
  constructor(readonly match: ISearchMatch, readonly result: ISearchResult, query: string, matchCase: boolean) {
    const text = match.text.trim();
    const labelObj: vscode.TreeItemLabel = {
      label: text,
      highlights: highlightRanges(text, query, matchCase),
    };
    super(labelObj, vscode.TreeItemCollapsibleState.None);
    const loc = match.member
      ? match.line != null ? `${match.member}:${match.line}` : match.member
      : match.line != null ? String(match.line) : '';
    this.description = loc;
    this.iconPath = new vscode.ThemeIcon(
      'search-result',
      new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    );
    this.tooltip = text;
    this.contextValue = 'searchMatch';
    this.command = {
      command: 'objectscriptSearch.openFile',
      title: 'Open match',
      arguments: [result.name, result.category, match.member, match.line, match.attrline, match.attr, match.text],
    };
  }
}

type SearchNode = FileItem | MatchItem;

/** Discriminated-union items used inside the search QuickPick (#4 + #7). */
type SearchPickItem = vscode.QuickPickItem & (
  | { _kind: 'run-search'; _query: string }
  | { _kind: 'history';    _query: string }
  | { _kind: 'result';     _name: string; _category: string }
);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class SearchTreeProvider implements vscode.TreeDataProvider<SearchNode>, vscode.Disposable {
  static readonly viewType = 'ObjectScriptSearch';

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SearchNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _results: ISearchResult[] = [];
  private _configWatcher?: vscode.Disposable;
  private _cts?: vscode.CancellationTokenSource;     // #1 cancel in-flight search
  private _statusBar!: vscode.StatusBarItem;          // #3 status bar item
  private _history: string[] = [];                    // #4 search history

  // Search options (persisted to workspaceState — #2)
  private _categories: DocCategory[] = ['CLS', 'RTN', 'INC'];
  private _includeSystem    = false;
  private _includeGenerated = false;
  private _matchCase        = false;
  private _matchWord        = false;
  private _useRegex         = false;
  private _lastQuery        = '';

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _searchService: SearchService,
  ) {
    // #2 Restore persisted options from workspace state
    const ws = this._context.workspaceState;
    this._categories       = ws.get('osc.categories',   ['CLS', 'RTN', 'INC']) as DocCategory[];
    this._includeSystem    = ws.get('osc.incSystem',    false) as boolean;
    this._includeGenerated = ws.get('osc.incGenerated', false) as boolean;
    this._matchCase        = ws.get('osc.matchCase',    false) as boolean;
    this._matchWord        = ws.get('osc.matchWord',    false) as boolean;
    this._useRegex         = ws.get('osc.useRegex',     false) as boolean;
    this._history          = ws.get('osc.history',      [])    as string[];

    // #3 Status bar item
    const sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    sb.command = 'objectscriptSearch.search';
    sb.tooltip = 'ObjectScript Search — click to search';
    this._statusBar = sb;
    this._context.subscriptions.push(sb);

    this._checkConnectionStatus();
    const watcher = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('objectscript') || e.affectsConfiguration('intersystems.servers')) {
        this._checkConnectionStatus();
      }
    });
    this._configWatcher = watcher;
    this._context.subscriptions.push(watcher);
  }

  dispose(): void {
    this._configWatcher?.dispose();
    this._onDidChangeTreeData.dispose();
    this._cts?.cancel();
    this._cts?.dispose();
  }

  // ── TreeDataProvider ──────────────────────────────────────────────────────

  getTreeItem(element: SearchNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SearchNode): SearchNode[] {
    if (!element) {
      return this._results.map(r => new FileItem(r, this._lastQuery, this._matchCase));
    }
    if (element instanceof FileItem) {
      return element.result.matches.map(m => new MatchItem(m, element.result, this._lastQuery, this._matchCase));
    }
    return [];
  }

  // ── Public commands ───────────────────────────────────────────────────────

  async search(): Promise<void> {
    // #5 Namespace picker — collect all active connections
    const allConns = await getAllConnections();
    if (allConns.length === 0) {
      vscode.window.showWarningMessage(NO_CONNECTION_MSG);
      return;
    }

    let conn: IConnection;
    if (allConns.length === 1) {
      conn = allConns[0];
    } else {
      type ConnItem = vscode.QuickPickItem & { _conn: IConnection };
      const pick = await vscode.window.showQuickPick<ConnItem>(
        allConns.map(c => ({
          label:       c.serverName ?? c.host,
          description: c.ns,
          detail:      c.wsFolderName,
          _conn:       c,
        })),
        { title: 'Select IRIS Namespace', placeHolder: 'Pick a connection…' },
      );
      if (!pick) { return; }
      conn = pick._conn;
    }

    // #4+#7 Rich picker: history + debounced live preview
    const query = await this._showSearchPicker(conn);
    if (!query) { return; }
    this._lastQuery = query;

    // Persist history (#4)
    this._history = [query, ...this._history.filter(h => h !== query)].slice(0, 20);
    void this._context.workspaceState.update('osc.history', this._history);

    // #1 Cancel any in-flight search and issue a fresh token
    this._cts?.cancel();
    this._cts?.dispose();
    this._cts = new vscode.CancellationTokenSource();
    const token = this._cts.token;

    this._results = [];
    this._onDidChangeTreeData.fire();

    // #3 Status bar: searching…
    this._statusBar.text    = `$(loading~spin) "${query}"`;
    this._statusBar.tooltip = `Searching IRIS for "${query}"…`;
    this._statusBar.show();

    let totalFiles   = 0;
    let totalMatches = 0;

    await vscode.window.withProgress(
      { location: { viewId: SearchTreeProvider.viewType } },
      async () => {
        try {
          await this._searchService.runSearch(
            conn,
            query,
            this._categories,
            this._includeSystem,
            this._includeGenerated,
            this._useRegex,
            this._matchCase,
            this._matchWord,
            (_batch, _si, tf, tm) => {
              if (token.isCancellationRequested) { return; }
              this._results.push(..._batch);
              totalFiles   = tf;
              totalMatches = tm;
              this._onDidChangeTreeData.fire();
            },
            token,
          );
        } catch (err) {
          if (!token.isCancellationRequested) {
            vscode.window.showErrorMessage(
              `ObjectScript Search: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      },
    );

    // #3 Status bar: result summary
    if (!token.isCancellationRequested) {
      this._statusBar.text = totalFiles === 0
        ? `$(search) "${query}" — no results`
        : `$(search) "${query}" — ${totalMatches} match${totalMatches === 1 ? '' : 'es'} in ${totalFiles} file${totalFiles === 1 ? '' : 's'}`;
      this._statusBar.tooltip = 'Click to run a new search';
    }
  }

  clearResults(): void {
    this._results   = [];
    this._lastQuery = '';
    this._onDidChangeTreeData.fire();
    this._statusBar.hide(); // #3
  }

  async showOptions(): Promise<void> {
    const items: vscode.QuickPickItem[] = [
      { label: '$(symbol-class) Classes',    description: 'CLS', picked: this._categories.includes('CLS'), alwaysShow: true },
      { label: '$(symbol-misc) Routines',    description: 'RTN', picked: this._categories.includes('RTN'), alwaysShow: true },
      { label: '$(file-symlink-file) Includes', description: 'INC', picked: this._categories.includes('INC'), alwaysShow: true },
      { label: '$(globe) Web files',         description: 'CSP', picked: this._categories.includes('CSP'), alwaysShow: true },
      { kind: vscode.QuickPickItemKind.Separator, label: 'Match options' },
      { label: '$(case-sensitive) Match Case',     description: 'cas', picked: this._matchCase,        alwaysShow: true },
      { label: '$(whole-word) Whole Word',          description: 'wrd', picked: this._matchWord,        alwaysShow: true },
      { label: '$(regex) Regular Expression',       description: 'rgx', picked: this._useRegex,         alwaysShow: true },
      { kind: vscode.QuickPickItemKind.Separator, label: 'Scope' },
      { label: '$(settings) Include System',  description: 'sys', picked: this._includeSystem,    alwaysShow: true },
      { label: '$(gear) Include Generated',   description: 'gen', picked: this._includeGenerated,  alwaysShow: true },
    ];

    const result = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: 'ObjectScript Search Options',
      placeHolder: 'Select file types and match options',
    });
    if (result === undefined) { return; }

    const desc = new Set(result.map(i => i.description!));
    this._categories       = (['CLS', 'RTN', 'INC', 'CSP'] as const).filter(c => desc.has(c));
    if (this._categories.length === 0) { this._categories = ['CLS', 'RTN', 'INC']; }
    this._matchCase        = desc.has('cas');
    this._matchWord        = desc.has('wrd');
    this._useRegex         = desc.has('rgx');
    this._includeSystem    = desc.has('sys');
    this._includeGenerated = desc.has('gen');

    // #2 Persist updated options to workspace state
    const ws = this._context.workspaceState;
    void ws.update('osc.categories',   this._categories);
    void ws.update('osc.matchCase',    this._matchCase);
    void ws.update('osc.matchWord',    this._matchWord);
    void ws.update('osc.useRegex',     this._useRegex);
    void ws.update('osc.incSystem',    this._includeSystem);
    void ws.update('osc.incGenerated', this._includeGenerated);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** #6 Copy all current results to the clipboard as Markdown. */
  async copyResults(): Promise<void> {
    if (this._results.length === 0) {
      vscode.window.showInformationMessage('ObjectScript Search: no results to copy.');
      return;
    }
    const lines: string[] = [`## ObjectScript Search — \`${this._lastQuery}\``, ''];
    for (const r of this._results) {
      lines.push(`### ${r.name}`);
      for (const m of r.matches) {
        const loc = m.member
          ? (m.line != null ? `${m.member}:${m.line}` : m.member)
          : (m.line != null ? String(m.line) : '');
        lines.push(`- \`${loc}\` ${m.text.trim()}`);
      }
      lines.push('');
    }
    await vscode.env.clipboard.writeText(lines.join('\n'));
    vscode.window.showInformationMessage(
      `Copied ${this._results.length} file${this._results.length === 1 ? '' : 's'} to clipboard.`,
    );
  }

  /**
   * #4+#7 Rich search QuickPick: shows history initially; as the user types,
   * fires a debounced live preview of matching documents.
   * Accepting a history/run-search item populates the tree.
   * Accepting a live-result item opens the document directly.
   */
  private _showSearchPicker(conn: IConnection): Promise<string | undefined> {
    return new Promise<string | undefined>(resolve => {
      let settled = false;
      const done = (value: string | undefined): void => {
        if (settled) { return; }
        settled = true;
        resolve(value);
      };

      const qp = vscode.window.createQuickPick<SearchPickItem>();
      qp.title              = `Search on IRIS — ${conn.serverName ?? conn.host} › ${conn.ns}`;
      qp.placeholder        = 'Type to preview · ↵ to populate tree · pick result to open file';
      qp.value              = this._lastQuery;
      qp.matchOnDescription = false;
      qp.matchOnDetail      = false;

      const historyItems = (): SearchPickItem[] =>
        this._history.map(h => ({
          label:       `$(history) ${h}`,
          description: 'history',
          alwaysShow:  true,
          _kind:       'history' as const,
          _query:      h,
        }));

      qp.items = historyItems();

      let debounceTimer: ReturnType<typeof setTimeout> | undefined;
      let liveCts: vscode.CancellationTokenSource | undefined;

      const cancelLive = (): void => {
        clearTimeout(debounceTimer);
        liveCts?.cancel();
        liveCts?.dispose();
        liveCts = undefined;
      };

      qp.onDidChangeValue(value => {
        cancelLive();
        const q = value.trim();
        if (!q) {
          qp.items = historyItems();
          qp.busy  = false;
          return;
        }

        const runItem: SearchPickItem = {
          label:       `$(search) Search for "${q}"`,
          description: 'populate tree',
          alwaysShow:  true,
          _kind:       'run-search',
          _query:      q,
        };
        qp.items = [runItem, ...historyItems()];

        debounceTimer = setTimeout(async () => {
          liveCts = new vscode.CancellationTokenSource();
          const tok = liveCts.token;
          qp.busy = true;
          const liveItems: SearchPickItem[] = [];
          try {
            await this._searchService.runSearch(
              conn, q,
              this._categories, this._includeSystem, this._includeGenerated,
              this._useRegex, this._matchCase, this._matchWord,
              (batch) => {
                if (tok.isCancellationRequested) { return; }
                for (const r of batch) {
                  const n = r.matches.length;
                  liveItems.push({
                    label:       `$(file) ${r.name}`,
                    description: `${n} match${n === 1 ? '' : 'es'}`,
                    detail:      r.matches[0]?.text.trim(),
                    alwaysShow:  true,
                    _kind:       'result',
                    _name:       r.name,
                    _category:   r.category,
                  });
                }
                if (!tok.isCancellationRequested) {
                  qp.items = [runItem, ...liveItems, ...historyItems()];
                }
              },
              tok,
            );
          } catch { /* live-search errors are silent */ }
          if (!tok.isCancellationRequested) { qp.busy = false; }
        }, 300);
      });

      qp.onDidAccept(() => {
        const [active] = qp.activeItems;
        cancelLive();
        qp.hide();
        if (!active) {
          done(qp.value.trim() || undefined);
          return;
        }
        if (active._kind === 'run-search' || active._kind === 'history') {
          done(active._query);
          return;
        }
        if (active._kind === 'result') {
          void this._searchService.openDocument(active._name, active._category);
          done(undefined);
        }
      });

      qp.onDidHide(() => {
        cancelLive();
        qp.dispose();
        done(undefined);
      });

      qp.show();
    });
  }

  private async _checkConnectionStatus(): Promise<void> {
    const conn = await getConnection();
    await vscode.commands.executeCommand('setContext', 'objectscriptSearch.connected', !!conn);
  }
}
