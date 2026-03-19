import * as vscode from 'vscode';
import type { ISearchResult, ISearchMatch, DocCategory, IConnection } from '../types';
import { getConnection, getAllConnections, NO_CONNECTION_MSG, onDidChangeObjectScriptConnection } from '../connection/IrisConnectionService';
import { SearchService } from './SearchService';
import { buildObjectScriptUri } from '../utils/uri';
import { resolveMatchLine } from '../utils/matchResolver';

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

const CATEGORY_LABEL: Record<string, string> = {
  CLS: 'Class',
  MAC: 'MAC Routine',
  INT: 'INT Routine',
  INC: 'Include',
  CSP: 'Web (CSP) File',
  RTN: 'Routine',
  PKG: 'Package',
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

    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    md.appendMarkdown(`**${result.name}**\n\n`);
    const typeLabel = CATEGORY_LABEL[result.category] ?? result.category;
    md.appendMarkdown(`$(file-code) Type: **${typeLabel}**  ·  $(search) **${n}** match${n === 1 ? '' : 'es'}`);

    // Show the first few match locations as a quick overview
    const preview = result.matches.slice(0, 5);
    if (preview.length > 0) {
      md.appendMarkdown(`\n\n---\n\n`);
      for (const m of preview) {
        const parts: string[] = [];
        if (m.member) {
          parts.push(m.line != null ? `${m.member}:${m.line} (relative)` : m.member);
        } else if (m.line != null) {
          parts.push(`Line ${m.line} (absolute)`);
        }
        if (m.attrline != null) {
          parts.push(`attr line ${m.attrline} (relative)`);
        }
        const locSuffix = parts.length > 0 ? ` *(${parts.join('  ·  ')})*` : '';
        md.appendMarkdown(`$(triangle-right) \`${m.text.trim()}\`${locSuffix}\n\n`);
      }
      if (result.matches.length > 5) {
        md.appendMarkdown(`*… and ${result.matches.length - 5} more*`);
      }
    }

    this.tooltip = md;

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
    // tooltip is intentionally left undefined so resolveTreeItem can build it
    // lazily (including the calculated absolute line number for in-member matches)

    this.contextValue = 'searchMatch';
    this.command = {
      command: 'objectscriptSearch.openFile',
      title: 'Open match',
      arguments: [result.name, result.category, match.member, match.line, match.attrline, match.attr, match.text],
    };
  }
}

type SearchNode = FileItem | MatchItem;

/** Discriminated-union items used inside the search QuickPick. */
type SearchPickItem = vscode.QuickPickItem & (
  | { _kind: 'history'; _query: string }
  | { _kind: 'toggle';  _opt: 'cas' | 'wrd' | 'rgx' }
  | { _kind: 'separator' }
);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class SearchTreeProvider implements vscode.TreeDataProvider<SearchNode>, vscode.Disposable {
  static readonly viewType = 'ObjectScriptSearch';

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SearchNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _results: ISearchResult[] = [];
  /** Last connection used for a search — kept internally to resolve absolute lines in tooltips. */
  private _lastConn?: IConnection;
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

    // Also re-check whenever vscode-objectscript itself changes the connection
    // (e.g. after it resolves a docker-compose port into workspaceState).
    // This event fires independently of settings changes, so onDidChangeConfiguration
    // alone would miss docker-compose reconnects where conn.active stays true.
    const connChangeDisposable = onDidChangeObjectScriptConnection(() => {
      this._checkConnectionStatus();
    });
    if (connChangeDisposable) {
      this._context.subscriptions.push(connChangeDisposable);
    }
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

  /**
   * Called lazily by VS Code when the tooltip is about to be shown (tooltip must be undefined
   * in the tree item for this to trigger). Builds the full MatchItem tooltip and, when the match
   * is inside a class member, fetches the document to compute the absolute line number.
   */
  async resolveTreeItem(
    item: vscode.TreeItem,
    element: SearchNode,
    token: vscode.CancellationToken,
  ): Promise<vscode.TreeItem> {
    if (!(element instanceof MatchItem)) { return item; }
    const { match, result } = element;

    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    md.appendMarkdown(`$(file-code) **${result.name}**\n\n`);
    if (match.member) {
      md.appendMarkdown(`$(symbol-method) Member: \`${match.member}\`\n\n`);
    }
    if (match.attr) {
      md.appendMarkdown(`$(tag) Attribute: \`${match.attr}\`\n\n`);
    }
    if (match.line != null) {
      if (match.member) {
        md.appendMarkdown(`$(list-ordered) Line in member: **${match.line}** *(relative)*\n\n`);
      } else {
        md.appendMarkdown(`$(list-ordered) Line in document: **${match.line}** *(absolute)*\n\n`);
      }
    }
    if (match.attrline != null) {
      md.appendMarkdown(`$(list-ordered) Line in attribute: **${match.attrline}** *(relative)*\n\n`);
    }

    // When the match is inside a member, 'line' is relative — compute the absolute
    // document line by fetching the document source and running the match resolver.
    if (match.member != null) {
      const conn = this._lastConn;
      if (conn?.wsFolderName && !token.isCancellationRequested) {
        try {
          const uri = buildObjectScriptUri(result.name, conn.wsFolderName, conn.ns);
          const textDoc = await vscode.workspace.openTextDocument(uri);
          if (!token.isCancellationRequested) {
            const content = textDoc.getText().split(/\r?\n/);
            const multilineMethodArgs = vscode.workspace
              .getConfiguration('objectscript')
              .get<boolean>('multilineMethodArgs', false);
            const resolvedLine = resolveMatchLine(content, match, result.name, multilineMethodArgs);
            if (resolvedLine !== null) {
              // resolvedLine is 0-based; display as 1-based
              md.appendMarkdown(`$(list-ordered) Line in document: **${resolvedLine + 1}** *(absolute, calculated)*\n\n`);
            }
          }
        } catch {
          // ignore — tooltip will simply not include the calculated absolute line
        }
      }
    }

    md.appendMarkdown(`---\n\n`);
    md.appendCodeblock(match.text.trim(), 'objectscript');
    item.tooltip = md;
    return item;
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

    const query = await this._showSearchPicker(conn);
    if (!query) { return; }
    this._lastQuery = query;
    this._lastConn = conn;

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
   * Search QuickPick: shows history initially; as the user types the query
   * is updated. Accepting a history item or the run-search item populates the tree.
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
      qp.placeholder        = 'Type a query · ↵ to search · pick history to reuse';
      qp.value              = this._lastQuery;
      qp.matchOnDescription = false;
      qp.matchOnDetail      = false;

      // ── Helpers ──────────────────────────────────────────────────────────

      const optionSep = (): SearchPickItem =>
        ({ kind: vscode.QuickPickItemKind.Separator, label: 'Options', _kind: 'separator' } as SearchPickItem);

      const optionItems = (): SearchPickItem[] => [
        {
          label:      `${this._matchCase ? '$(check)' : '$(circle-large-outline)'} Match Case`,
          alwaysShow: true, _kind: 'toggle', _opt: 'cas',
        } as SearchPickItem,
        {
          label:      `${this._matchWord ? '$(check)' : '$(circle-large-outline)'} Whole Word`,
          alwaysShow: true, _kind: 'toggle', _opt: 'wrd',
        } as SearchPickItem,
        {
          label:      `${this._useRegex ? '$(check)' : '$(circle-large-outline)'} Regular Expression`,
          alwaysShow: true, _kind: 'toggle', _opt: 'rgx',
        } as SearchPickItem,
      ];

      const historyItems = (): SearchPickItem[] =>
        this._history.map(h => ({
          label:       `$(history) ${h}`,
          description: 'history',
          alwaysShow:  false,
          _kind:       'history' as const,
          _query:      h,
        }));

      const buildItems = (): SearchPickItem[] => [
        ...historyItems(),
        optionSep(),
        ...optionItems(),
      ];

      qp.items = buildItems();

      qp.onDidChangeValue(() => {
        qp.items = buildItems();
      });

      qp.onDidAccept(() => {
        const [active] = qp.activeItems;
        // Toggle option — keep picker open, refresh option items
        if (active?._kind === 'toggle') {
          if      (active._opt === 'cas') { this._matchCase = !this._matchCase; void this._context.workspaceState.update('osc.matchCase', this._matchCase); }
          else if (active._opt === 'wrd') { this._matchWord = !this._matchWord; void this._context.workspaceState.update('osc.matchWord', this._matchWord); }
          else if (active._opt === 'rgx') { this._useRegex  = !this._useRegex;  void this._context.workspaceState.update('osc.useRegex',  this._useRegex);  }
          qp.items = buildItems();
          return;
        }
        qp.hide();
        if (active?._kind === 'history') {
          done(active._query);
        } else {
          done(qp.value.trim() || undefined);
        }
      });

      qp.onDidHide(() => {
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
