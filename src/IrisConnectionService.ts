import * as vscode from 'vscode';
import type { IConnection } from './types';

const OBJECTSCRIPT_EXT_ID = 'intersystems-community.vscode-objectscript';
const SM_AUTH_PROVIDER_ID = 'intersystems-servermanager';

/** Subset of the vscode-objectscript public API that we consume. */
interface ObjectScriptExtAPI {
  asyncServerForUri(uri: vscode.Uri): Promise<{
    serverName?: string;
    active: boolean;
    scheme: string;
    host: string;
    port: number;
    pathPrefix: string;
    username: string;
    password?: string;
    namespace: string;
  }>;
}

/**
 * Resolves the active IRIS connection by delegating to the vscode-objectscript
 * extension's public `asyncServerForUri` API.
 *
 * This handles all connection types supported by vscode-objectscript:
 *   - Inline `objectscript.conn` (host/port/username/password)
 *   - Named server via `objectscript.conn.server` → `intersystems.servers.*`
 *   - Docker-compose port resolution
 *
 * For named servers whose passwords are stored in the OS keychain (not in
 * plain settings), the Server Manager authentication provider is queried
 * silently to retrieve the credential.
 */
export async function getConnection(): Promise<IConnection | undefined> {
  const ext = vscode.extensions.getExtension<ObjectScriptExtAPI>(OBJECTSCRIPT_EXT_ID);
  if (!ext) return undefined;
  if (!ext.isActive) await ext.activate();

  const api = ext.exports;

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    // Quick-filter: only consider folders where the user has enabled the connection.
    const conn = vscode.workspace
      .getConfiguration('objectscript', folder)
      .get<Record<string, unknown>>('conn');
    if (conn?.active !== true) continue;

    try {
      const info = await api.asyncServerForUri(folder.uri);
      if (!info.active || !info.host || !info.port) continue;

      let password = info.password;

      // Named servers store their password in the OS keychain via the Server
      // Manager authentication provider. The public API omits it; retrieve it
      // silently so we can make authenticated HTTP requests.
      if (password === undefined && info.serverName) {
        const session = await vscode.authentication
          .getSession(SM_AUTH_PROVIDER_ID, [info.serverName, info.username ?? ''], { silent: true })
          .then(s => s, () => undefined);
        password = session?.accessToken;
      }

      return {
        serverName: info.serverName,
        host: info.host,
        port: info.port,
        scheme: info.scheme || 'http',
        pathPrefix: info.pathPrefix || '',
        namespace: (info.namespace || 'USER').toUpperCase(),
        username: info.username || '_SYSTEM',
        password: password ?? '',
      };
    } catch {
      continue;
    }
  }

  return undefined;
}

