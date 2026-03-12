import * as vscode from 'vscode';
import type { ISearchMatch, ISearchResult, DocCategory } from './types';
import { getConnection } from './IrisConnectionService';
import { AtelierAPI, searchStream, categoryFromDocName } from './api';
import { resolveMatchLine } from './matchResolver';

/**
 * Build the `objectscript://` URI used by vscode-objectscript's
 * DocumentContentProvider to open a server-side document.
 *
 * - `.cls` files:  `My.Package.ClassName.cls` → `/My/Package/ClassName.cls`
 * - other files:   `MyRoutine.mac`            → `/MyRoutine.mac`
 *
 * @param name          Full document name, e.g. "My.Package.ClassName.cls"
 * @param wsFolderName  Workspace folder name — becomes the URI authority so
 *                      vscode-objectscript can find the server settings.
 * @param namespace     IRIS namespace, e.g. "IRISAPP"
 */
export function buildObjectScriptUri(
  name: string,
  wsFolderName: string,
  ns: string,
): vscode.Uri {
  const ext = name.split('.').pop() ?? '';
  const stem = name.slice(0, -(ext.length + 1));
  const filePath = ext.toLowerCase() === 'cls'
    ? stem.replace(/\./g, '/') + '.' + ext
    : name;

  return vscode.Uri.from({
    scheme: 'objectscript',
    authority: wsFolderName,
    path: `/${filePath}`,
    query: `ns=${ns}`,
  });
}

/**
 * Encapsulates IRIS search and document-open business logic, decoupled from
 * the VS Code WebviewViewProvider machinery.  Mirrors the separation of
 * concerns used by TextSearchProvider in vscode-objectscript: the provider
 * owns the VS Code API surface while this service owns the Atelier API calls,
 * connection resolution, and sync/async path switching.
 */
export class SearchService {
  /**
   * Runs a streaming search against the active IRIS server, calling
   * `onBatch` for each batch of results as they arrive.
   *
   * Throws if no active ObjectScript connection is found.
   */
  async runSearch(
    query: string,
    categories: string[],
    includeSystem: boolean,
    includeGenerated: boolean,
    regex: boolean,
    caseSensitive: boolean,
    wordMatch: boolean,
    onBatch: (
      results: ISearchResult[],
      serverInfo: string,
      totalFiles: number,
      totalMatches: number,
    ) => void,
  ): Promise<void> {
    const connection = await getConnection();
    if (!connection) {
      throw new Error(
        'No active ObjectScript connection found.\n\n' +
        'Add a server in "intersystems.servers" and set "objectscript.conn" in your workspace settings.',
      );
    }

    const cfg = vscode.workspace.getConfiguration('objectscriptSearch');
    const maxResults = cfg.get<number>('maxResults', 100);

    const opts = {
      query,
      categories: categories as DocCategory[],
      maxResults,
      includeSystem,
      includeGenerated,
      regex,
      caseSensitive,
      wordMatch,
    };

    const api = new AtelierAPI(connection);
    const serverInfo = connection.serverName ?? connection.host;
    let totalFiles = 0;
    let totalMatches = 0;

    for await (const batch of searchStream(api, opts)) {
      const results: ISearchResult[] = batch.map((doc) => ({
        name: doc.doc,
        category: categoryFromDocName(doc.doc),
        matches: doc.matches,
      }));
      totalFiles += results.length;
      totalMatches += results.reduce((n, r) => n + (r.matches?.length ?? 0), 0);
      onBatch(results, serverInfo, totalFiles, totalMatches);
    }
  }

  /**
   * Opens a server-side document at the given location via the
   * vscode-objectscript DocumentContentProvider, resolving the exact line
   * using the same algorithm as TextSearchProvider.
   */
  async openDocument(
    name: string,
    _category: string,
    member?: string,
    line?: number,
    attrline?: number,
    attr?: string,
    matchText?: string,
  ): Promise<void> {
    const connection = await getConnection();
    if (!connection) {
      vscode.window.showErrorMessage('ObjectScript Search: no active connection to open file.');
      return;
    }

    const wsFolder = this.findActiveObjectScriptFolder();
    if (!wsFolder) {
      vscode.window.showErrorMessage(
        'ObjectScript Search: no workspace folder with an active ObjectScript connection found. ' +
        'Open a folder and configure "objectscript.conn" in its settings.',
      );
      return;
    }

    const uri = buildObjectScriptUri(name, wsFolder.name, connection.ns);

    try {
      await vscode.commands.executeCommand('vscode-objectscript.explorer.open', uri);

      const textDoc = await vscode.workspace.openTextDocument(uri);

      // Resolve the target position using the ported vscode-objectscript algorithm.
      const content = textDoc.getText().split(/\r?\n/);
      const multilineMethodArgs = vscode.workspace
        .getConfiguration('objectscript')
        .get<boolean>('multilineMethodArgs', false);
      const match: ISearchMatch = { text: matchText ?? '', member, line, attrline, attr };
      const resolvedLine = resolveMatchLine(content, match, name, multilineMethodArgs);

      if (resolvedLine !== null) {
        const pos = new vscode.Position(resolvedLine, 0);
        await vscode.window.showTextDocument(textDoc, { selection: new vscode.Range(pos, pos) });
      }
    } catch {
      vscode.window.showWarningMessage(
        `ObjectScript Search: cannot open "${name}". ` +
        'Make sure the InterSystems ObjectScript extension is installed and active.',
      );
    }
  }

  /** Returns the first workspace folder whose objectscript.conn is active. */
  findActiveObjectScriptFolder(): vscode.WorkspaceFolder | undefined {
    for (const wf of vscode.workspace.workspaceFolders ?? []) {
      const conn = vscode.workspace
        .getConfiguration('objectscript', wf)
        .get<Record<string, unknown>>('conn');
      if (conn?.active === true) {
        return wf;
      }
    }
    return undefined;
  }
}
