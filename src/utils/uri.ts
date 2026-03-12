import * as vscode from 'vscode';

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
 * @param ns            IRIS namespace, e.g. "IRISAPP"
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
