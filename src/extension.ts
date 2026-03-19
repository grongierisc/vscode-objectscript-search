import * as vscode from 'vscode';
import { SearchTreeProvider } from './search/SearchTreeProvider';
import { SearchService } from './search/SearchService';

/**
 * Opens the JSON settings file that contains `objectscript.conn` and positions
 * the cursor on that key. If the setting is not yet defined in any workspace or
 * folder settings, reveals the Server Manager sidebar instead so the user can
 * add a server connection from there.
 */
async function openConnectionSettings(): Promise<void> {
  // ── 1. Search workspace-folder–level settings (.vscode/settings.json) ──
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const inspect = vscode.workspace
      .getConfiguration('objectscript', folder)
      .inspect('conn');
    if (inspect?.workspaceFolderValue !== undefined) {
      const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'settings.json');
      await openJsonFileAtKey(uri, '"objectscript.conn"');
      return;
    }
  }

  // ── 2. Search workspace-level settings (.code-workspace file) ────────────
  const workspaceInspect = vscode.workspace
    .getConfiguration('objectscript')
    .inspect('conn');
  if (workspaceInspect?.workspaceValue !== undefined && vscode.workspace.workspaceFile) {
    await openJsonFileAtKey(vscode.workspace.workspaceFile, '"objectscript.conn"');
    return;
  }

  // ── 3. Setting not found — reveal Server Manager so user can add a server ─
  await vscode.commands.executeCommand(
    'workbench.view.extension.intersystems-community_servermanager',
  );
}

/** Opens `uri` as a text document and positions the cursor on `searchKey`. */
async function openJsonFileAtKey(uri: vscode.Uri, searchKey: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const text = doc.getText();
  const idx = text.indexOf(searchKey);
  const pos = idx >= 0
    ? doc.positionAt(idx)
    : new vscode.Position(0, 0);
  const range = new vscode.Range(pos, pos.translate(0, idx >= 0 ? searchKey.length : 0));
  await vscode.window.showTextDocument(doc, { selection: range });
}

export function activate(context: vscode.ExtensionContext): void {
  const searchService = new SearchService();
  const provider = new SearchTreeProvider(context, searchService);

  context.subscriptions.push(
    provider,
    vscode.window.registerTreeDataProvider(SearchTreeProvider.viewType, provider),
    vscode.commands.registerCommand('objectscriptSearch.search',      () => provider.search()),
    vscode.commands.registerCommand('objectscriptSearch.showOptions',  () => provider.showOptions()),
    vscode.commands.registerCommand('objectscriptSearch.clearResults', () => provider.clearResults()),
    vscode.commands.registerCommand('objectscriptSearch.copyResults',  () => provider.copyResults()),
    vscode.commands.registerCommand('objectscriptSearch.openConnectionSettings', openConnectionSettings),
    vscode.commands.registerCommand(
      'objectscriptSearch.openFile',
      (name: string, category: string, member?: string, line?: number, attrline?: number, attr?: string, text?: string) =>
        searchService.openDocument(name, category, member, line, attrline, attr, text),
    ),
  );
}

export function deactivate(): void {}
