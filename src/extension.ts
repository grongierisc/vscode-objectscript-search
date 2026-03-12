import * as vscode from 'vscode';
import type { ISearchMatch } from './types';
import { SearchViewProvider } from './SearchViewProvider';
import { SearchService } from './SearchService';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SearchViewProvider();
  const service = new SearchService();

  const treeView = vscode.window.createTreeView(SearchViewProvider.viewType, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  provider.setTreeView(treeView);

  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand('objectscriptSearch.search',      () => provider.promptSearch()),
    vscode.commands.registerCommand('objectscriptSearch.showFilters', () => provider.showFilters()),
    vscode.commands.registerCommand('objectscriptSearch.clear',       () => provider.clear()),
    vscode.commands.registerCommand(
      'objectscriptSearch.openFile',
      (name: string, category: string, match?: ISearchMatch) =>
        service.openDocument(name, category, match?.member, match?.line, match?.attrline, match?.attr, match?.text),
    ),
    // Keep the existing palette shortcut for focusing the view
    vscode.commands.registerCommand('vscode-objectscript-search.focus', () =>
      vscode.commands.executeCommand('ObjectScriptSearch.focus'),
    ),
  );
}

export function deactivate(): void {}
