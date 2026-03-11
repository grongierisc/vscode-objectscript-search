import * as vscode from 'vscode';
import { SearchViewProvider } from './SearchViewProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SearchViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SearchViewProvider.viewType, provider, {
      // Keep the webview alive when the view is hidden so search state is preserved
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Command palette shortcut to focus the search view
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-objectscript-search.focus', () => {
      vscode.commands.executeCommand('ObjectScriptSearch.focus');
    }),
  );
}

export function deactivate(): void {
  // Nothing to clean up
}
