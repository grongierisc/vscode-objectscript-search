import * as vscode from 'vscode';
import { SearchViewProvider } from './SearchViewProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SearchViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SearchViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('objectscriptSearch.showFilters', () => provider.showFilters()),
    vscode.commands.registerCommand('vscode-objectscript-search.focus', () =>
      vscode.commands.executeCommand('ObjectScriptSearch.focus'),
    ),
  );
}

export function deactivate(): void {}
