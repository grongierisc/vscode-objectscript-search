import * as vscode from 'vscode';
import type { ISearchResult, ISearchMatch, DocCategory } from '../types';
import { getConnection, NO_CONNECTION_MSG } from '../connection/IrisConnectionService';
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

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class SearchTreeProvider implements vscode.TreeDataProvider<SearchNode>, vscode.Disposable {
  static readonly viewType = 'ObjectScriptSearch';

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SearchNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _results: ISearchResult[] = [];
  private _configWatcher?: vscode.Disposable;

  // Search state (persisted across searches in this session)
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
    const conn = await getConnection();
    if (!conn) {
      vscode.window.showWarningMessage(NO_CONNECTION_MSG);
      return;
    }

    const query = await vscode.window.showInputBox({
      title: 'Search on IRIS',
      prompt: `${conn.serverName ?? conn.host} › ${conn.ns}`,
      placeHolder: 'Enter search term…',
      value: this._lastQuery,
    });
    if (!query?.trim()) { return; }
    this._lastQuery = query.trim();

    // Clear previous results so the tree empties before new results arrive
    this._results = [];
    this._onDidChangeTreeData.fire();

    await vscode.window.withProgress(
      { location: { viewId: SearchTreeProvider.viewType } },
      async () => {
        try {
          await this._searchService.runSearch(
            conn,
            this._lastQuery,
            this._categories,
            this._includeSystem,
            this._includeGenerated,
            this._useRegex,
            this._matchCase,
            this._matchWord,
            (batch) => {
              this._results.push(...batch);
              this._onDidChangeTreeData.fire();
            },
          );
        } catch (err) {
          vscode.window.showErrorMessage(
            `ObjectScript Search: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    );
  }

  clearResults(): void {
    this._results = [];
    this._lastQuery = '';
    this._onDidChangeTreeData.fire();
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
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async _checkConnectionStatus(): Promise<void> {
    const conn = await getConnection();
    await vscode.commands.executeCommand('setContext', 'objectscriptSearch.connected', !!conn);
  }
}
