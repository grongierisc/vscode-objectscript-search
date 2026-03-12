import * as vscode from 'vscode';
import { getConnection } from './IrisConnectionService';
import { SearchService } from './SearchService';

// Webview resources live in media/ (not bundled by webpack)
const MEDIA_CSS = 'search.css';
const MEDIA_JS  = 'search.js';

export class SearchViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ObjectScriptSearch';

  private _view?: vscode.WebviewView;
  private _configWatcher?: vscode.Disposable;
  private readonly _searchService = new SearchService();

  private _categories: string[] = ['CLS', 'RTN', 'INC'];
  private _includeSystem = false;
  private _includeGenerated = false;

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
    webviewView.webview.html = this._buildHtml();

    webviewView.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      switch (msg.type) {
        case 'search':
          await this._handleSearch(msg.query, msg.matchCase, msg.matchWord, msg.useRegex);
          break;
        case 'openFile':
          await this._searchService.openDocument(
            msg.name, msg.category, msg.member, msg.line, msg.attrline, msg.attr, msg.text,
          );
          break;
        case 'showFilters':
          await this._handleShowFilters(msg.categories, msg.includeSystem, msg.includeGenerated);
          break;
      }
    });

    this._checkConnectionStatus();
    this._configWatcher?.dispose();
    this._configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('objectscript') || e.affectsConfiguration('intersystems.servers')) {
        this._checkConnectionStatus();
      }
    });
  }

  /** Called from the toolbar "Filters…" command. */
  showFilters(): void {
    this._post({ type: 'requestFilters' });
  }

  // ---------------------------------------------------------------------------

  private async _checkConnectionStatus(): Promise<void> {
    const conn = await getConnection();
    this._post({ type: 'connStatus', ok: !!conn });
  }

  private async _handleSearch(
    query: string,
    matchCase: boolean,
    matchWord: boolean,
    useRegex: boolean,
  ): Promise<void> {
    this._post({ type: 'loading', loading: true });
    try {
      const conn = await getConnection();
      if (!conn) {
        throw new Error(
          'No active ObjectScript connection found.\n\n' +
          'Add a server in "intersystems.servers" and set "objectscript.conn" in your workspace settings.',
        );
      }
      await this._searchService.runSearch(
        query,
        this._categories,
        this._includeSystem,
        this._includeGenerated,
        useRegex,
        matchCase,
        matchWord,
        (results, serverInfo, totalFiles, totalMatches) => {
          this._post({ type: 'appendResults', results, serverInfo, totalFiles, totalMatches });
        },
      );
    } catch (err) {
      this._post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      this._post({ type: 'loading', loading: false });
    }
  }

  private async _handleShowFilters(
    categories: string[],
    includeSystem: boolean,
    includeGenerated: boolean,
  ): Promise<void> {
    this._categories = categories;
    this._includeSystem = includeSystem;
    this._includeGenerated = includeGenerated;

    const items: vscode.QuickPickItem[] = [
      { label: '$(symbol-class) Classes',    description: 'CLS', picked: categories.includes('CLS'), alwaysShow: true },
      { label: '$(symbol-misc) Routines',    description: 'RTN', picked: categories.includes('RTN'), alwaysShow: true },
      { label: '$(symbol-file) Includes',    description: 'INC', picked: categories.includes('INC'), alwaysShow: true },
      { label: '$(globe) Web files',         description: 'CSP', picked: categories.includes('CSP'), alwaysShow: true },
      { label: '$(settings) Include System', description: 'sys', picked: includeSystem,    alwaysShow: true },
      { label: '$(gear) Include Generated',  description: 'gen', picked: includeGenerated, alwaysShow: true },
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
      this._post({
        type: 'filtersUpdated',
        categories: this._categories,
        includeSystem: this._includeSystem,
        includeGenerated: this._includeGenerated,
      });
    }
  }

  private _post(message: Record<string, unknown>): void {
    this._view?.webview.postMessage(message);
  }

  // ---------------------------------------------------------------------------

  private _buildHtml(): string {
    const webview = this._view!.webview;
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', MEDIA_CSS));
    const jsUri  = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', MEDIA_JS));
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <div id="warn"></div>
  <div class="sw">
    <div class="ib">
      <input id="q" type="text" placeholder="Search on IRIS\u2026" autocomplete="off" spellcheck="false"/>
      <div class="tg">
        <button class="t" id="bc" title="Match Case (Alt+C)">Aa</button>
        <button class="t" id="bw" title="Match Whole Word (Alt+W)">ab|</button>
        <button class="t" id="br" title="Use Regular Expression (Alt+R)">.*</button>
      </div>
    </div>
  </div>
  <div class="fr">
    <span id="fsum"></span>
    <button class="fb" id="bf">Filters\u2026</button>
  </div>
  <div id="status"></div>
  <hr/>
  <div id="results"></div>
  <script src="${jsUri}"></script>
</body>
</html>`;
  }
}

type WebviewMessage =
  | { type: 'search'; query: string; matchCase: boolean; matchWord: boolean; useRegex: boolean }
  | { type: 'openFile'; name: string; category: string; member?: string; line?: number; attrline?: number; attr?: string; text?: string }
  | { type: 'showFilters'; categories: string[]; includeSystem: boolean; includeGenerated: boolean };
