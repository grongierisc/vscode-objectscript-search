import * as vscode from 'vscode';
import type { ISearchMatch, ISearchResult, DocCategory, IConnection } from '../types';
import { getConnection } from '../connection/IrisConnectionService';
import { AtelierAPI, searchStream, categoryFromDocName } from '../atelier';
import { buildObjectScriptUri } from '../utils/uri';
import { resolveMatchLine } from '../utils/matchResolver';

/**
 * Encapsulates IRIS search and document-open business logic, decoupled from
 * the VS Code WebviewViewProvider machinery.
 */
export class SearchService {
  /**
   * Runs a streaming search against the active IRIS server, calling
   * `onBatch` for each batch of results as they arrive.
   *
   * Accepts a pre-resolved `connection` so the caller avoids a redundant
   * `getConnection()` call when it has already checked the connection.
   */
  async runSearch(
    connection: IConnection,
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

    // Signal completion when no documents matched the query.
    if (totalFiles === 0) {
      onBatch([], serverInfo, 0, 0);
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

    const wsFolderName = connection.wsFolderName;
    if (!wsFolderName) {
      vscode.window.showErrorMessage(
        'ObjectScript Search: no workspace folder with an active ObjectScript connection found. ' +
        'Open a folder and configure "objectscript.conn" in its settings.',
      );
      return;
    }

    const uri = buildObjectScriptUri(name, wsFolderName, connection.ns);

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
}
