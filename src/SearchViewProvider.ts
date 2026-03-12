import * as vscode from 'vscode';
import type { ISearchResult } from './types';
import { getConnection } from './IrisConnectionService';
import { SearchService } from './SearchService';

// ---------------------------------------------------------------------------
// Tree item types
// ---------------------------------------------------------------------------

class FileResultItem extends vscode.TreeItem {
  readonly result: ISearchResult;

  constructor(result: ISearchResult) {
    super(result.name, vscode.TreeItemCollapsibleState.Expanded);
    this.result = result;
    const n = result.matches?.length ?? 0;
    this.description = `${n} ${n === 1 ? 'match' : 'matches'}`;
    this.tooltip = result.name;
    this.iconPath = new vscode.ThemeIcon(_categoryIcon(result.category));
    this.contextValue = 'fileResult';
  }
}

class MatchResultItem extends vscode.TreeItem {
  constructor(
    match: ISearchResult['matches'][number],
    fileName: string,
    fileCategory: string,
  ) {
    const label = match.text.trim() || '(empty)';
    super(label, vscode.TreeItemCollapsibleState.None);
    const loc = match.line ?? match.attrline ?? match.member ?? '';
    this.description = String(loc);
    this.tooltip = label;
    this.command = {
      command: 'objectscriptSearch.openFile',
      title: 'Open',
      arguments: [fileName, fileCategory, match],
    };
    this.contextValue = 'matchResult';
  }
}

type SearchTreeItem = FileResultItem | MatchResultItem;

function _categoryIcon(cat: string): string {
  const map: Record<string, string> = {
    CLS: 'symbol-class',
    MAC: 'file-code',
    INT: 'file-code',
    INC: 'code',
    CSP: 'globe',
    PKG: 'package',
    RTN: 'symbol-misc',
  };
  return map[cat.toUpperCase()] ?? 'file';
}

// ---------------------------------------------------------------------------
// Provider — pure VS Code native UI, zero HTML
// ---------------------------------------------------------------------------

export class SearchViewProvider implements vscode.TreeDataProvider<SearchTreeItem> {
  public static readonly viewType = 'ObjectScriptSearch';

  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<SearchTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _treeView?: vscode.TreeView<SearchTreeItem>;
  private readonly _searchService = new SearchService();

  // Search option state — persisted in memory between searches
  private _matchCase = false;
  private _matchWord = false;
  private _useRegex = false;
  private _categories: string[] = ['CLS', 'RTN', 'INC'];
  private _includeSystem = false;
  private _includeGenerated = false;
  private _lastQuery = '';

  private _results: ISearchResult[] = [];

  // ------- VS Code TreeDataProvider ---------------------------------------

  setTreeView(view: vscode.TreeView<SearchTreeItem>): void {
    this._treeView = view;
  }

  getTreeItem(element: SearchTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SearchTreeItem): SearchTreeItem[] {
    if (!element) {
      return this._results.map(r => new FileResultItem(r));
    }
    if (element instanceof FileResultItem) {
      return (element.result.matches ?? []).map(
        m => new MatchResultItem(m, element.result.name, element.result.category),
      );
    }
    return [];
  }

  // ------- Commands -------------------------------------------------------

  /**
   * Open a VS Code InputBox with inline Aa / ab| / .* toggle buttons.
   * Active toggles are coloured with `inputOption.activeForeground`.
   * On accept, runs the streaming search and populates the tree.
   */
  async promptSearch(): Promise<void> {
    const box = vscode.window.createInputBox();
    box.placeholder = 'Search on IRIS…';
    box.value = this._lastQuery;
    box.buttons = this._makeToggleButtons();

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) { return; }
      cleaned = true;
      sub.dispose();
      box.dispose();
    };

    const sub = vscode.Disposable.from(
      box.onDidTriggerButton((btn) => {
        const idx = Array.from(box.buttons).indexOf(btn);
        if (idx === 0) { this._matchCase = !this._matchCase; }
        else if (idx === 1) { this._matchWord = !this._matchWord; }
        else if (idx === 2) { this._useRegex = !this._useRegex; }
        box.buttons = this._makeToggleButtons();
      }),
      box.onDidAccept(async () => {
        const query = box.value.trim();
        cleanup();
        if (query) {
          this._lastQuery = query;
          await this._runSearch(query);
        }
      }),
      box.onDidHide(cleanup),
    );

    box.show();
  }

  /** Open the multi-select QuickPick for file-type / option filters. */
  async showFilters(): Promise<void> {
    const items: vscode.QuickPickItem[] = [
      { label: '$(symbol-class) Classes',   description: 'CLS', picked: this._categories.includes('CLS'), alwaysShow: true },
      { label: '$(symbol-misc) Routines',   description: 'RTN', picked: this._categories.includes('RTN'), alwaysShow: true },
      { label: '$(symbol-file) Includes',   description: 'INC', picked: this._categories.includes('INC'), alwaysShow: true },
      { label: '$(globe) Web files',        description: 'CSP', picked: this._categories.includes('CSP'), alwaysShow: true },
      { label: '$(settings) Include System',   description: 'sys', picked: this._includeSystem,    alwaysShow: true },
      { label: '$(gear) Include Generated',    description: 'gen', picked: this._includeGenerated, alwaysShow: true },
    ];

    const result = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: 'ObjectScript Search Filters',
      placeHolder: 'Select file types and options to include in the search',
    });

    if (result !== undefined) {
      const desc = new Set(result.map(i => i.description!));
      this._categories       = (['CLS', 'RTN', 'INC', 'CSP'] as const).filter(c => desc.has(c));
      this._includeSystem    = desc.has('sys');
      this._includeGenerated = desc.has('gen');
    }
  }

  /** Clear all results and return to the welcome state. */
  clear(): void {
    this._results = [];
    this._onDidChangeTreeData.fire();
    if (this._treeView) {
      this._treeView.description = undefined;
      this._treeView.message = undefined;
    }
    vscode.commands.executeCommand('setContext', 'objectscriptSearch.hasResults', false);
  }

  // ------- Private --------------------------------------------------------

  private async _runSearch(query: string): Promise<void> {
    this._results = [];
    this._onDidChangeTreeData.fire();
    this._setView({ description: 'Searching\u2026', message: undefined });
    vscode.commands.executeCommand('setContext', 'objectscriptSearch.hasResults', false);

    const connection = await getConnection();
    if (!connection) {
      this._setView({
        description: undefined,
        message:
          '\u26a0 No active ObjectScript connection. ' +
          'Set "objectscript.conn" in your workspace settings and set active to true.',
      });
      return;
    }

    try {
      let totalFiles = 0;
      let totalMatches = 0;

      await this._searchService.runSearch(
        query,
        this._categories,
        this._includeSystem,
        this._includeGenerated,
        this._useRegex,
        this._matchCase,
        this._matchWord,
        (results, _serverInfo, tf, tm) => {
          this._results.push(...results);
          totalFiles = tf;
          totalMatches = tm;
          this._onDidChangeTreeData.fire();
          this._setView({
            description: `${tm} ${tm === 1 ? 'match' : 'matches'} in ${tf} ${tf === 1 ? 'file' : 'files'}`,
          });
        },
      );

      if (this._results.length === 0) {
        this._setView({ description: undefined, message: 'No documents matched your query.' });
      } else {
        const suffix = totalMatches >= 200 ? ' (limit reached)' : '';
        this._setView({
          message: undefined,
          description:
            `${totalMatches} ${totalMatches === 1 ? 'match' : 'matches'} in ` +
            `${totalFiles} ${totalFiles === 1 ? 'file' : 'files'}${suffix}`,
        });
        vscode.commands.executeCommand('setContext', 'objectscriptSearch.hasResults', true);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._setView({ description: undefined, message });
    }
  }

  private _setView(opts: { description?: string; message?: string }): void {
    if (!this._treeView) { return; }
    if ('description' in opts) { this._treeView.description = opts.description; }
    if ('message' in opts) { this._treeView.message = opts.message; }
  }

  /** Create the three toggle buttons for the InputBox, colouring active ones. */
  private _makeToggleButtons(): vscode.QuickInputButton[] {
    const active = new vscode.ThemeColor('inputOption.activeForeground');
    return [
      {
        iconPath: new vscode.ThemeIcon('case-sensitive', this._matchCase ? active : undefined),
        tooltip: `Match Case \u2014 ${this._matchCase ? 'ON' : 'off'}`,
      },
      {
        iconPath: new vscode.ThemeIcon('whole-word', this._matchWord ? active : undefined),
        tooltip: `Match Whole Word \u2014 ${this._matchWord ? 'ON' : 'off'}`,
      },
      {
        iconPath: new vscode.ThemeIcon('regex', this._useRegex ? active : undefined),
        tooltip: `Use Regular Expression \u2014 ${this._useRegex ? 'ON' : 'off'}`,
      },
    ];
  }
}
