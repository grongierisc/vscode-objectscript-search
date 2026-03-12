import * as vscode from 'vscode';
import { SearchTreeProvider } from './search/SearchTreeProvider';
import { SearchService } from './search/SearchService';

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
    vscode.commands.registerCommand(
      'objectscriptSearch.openFile',
      (name: string, category: string, member?: string, line?: number, attrline?: number, attr?: string, text?: string) =>
        searchService.openDocument(name, category, member, line, attrline, attr, text),
    ),
  );
}

export function deactivate(): void {}
