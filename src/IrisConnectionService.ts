import * as vscode from 'vscode';
import type { IConnection } from './types';
import { AUTHENTICATION_PROVIDER as SM_AUTH_PROVIDER_ID } from '@intersystems-community/intersystems-servermanager';
import type { ServerManagerAPI } from '@intersystems-community/intersystems-servermanager';

const OBJECTSCRIPT_EXT_ID = 'intersystems-community.vscode-objectscript';
const SM_EXT_ID = 'intersystems-community.servermanager';

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
 * For named servers whose passwords are stored in the OS keychain, the Server
 * Manager extension's `getServerSpec` API resolves the credential (prompting
 * if necessary), with a direct auth-provider lookup as a fallback.
 */
export async function getConnection(): Promise<IConnection | undefined> {
  const ext = vscode.extensions.getExtension<ObjectScriptExtAPI>(OBJECTSCRIPT_EXT_ID);
  if (!ext) return undefined;
  if (!ext.isActive) await ext.activate();

  const api = ext.exports;

  // Server Manager is an extensionDependency so it is always present.
  const smExt = vscode.extensions.getExtension<ServerManagerAPI>(SM_EXT_ID);
  if (smExt && !smExt.isActive) await smExt.activate();
  const smApi = smExt?.exports;

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

      // Named servers store their password in the OS keychain via Server Manager.
      // asyncServerForUri intentionally omits it unless stored as plaintext in settings.
      // Use getServerSpec to resolve credentials (including prompting if needed),
      // then fall back to a direct auth-provider lookup with an account hint.
      if (!password && info.serverName && smApi) {
        const serverSpec = await smApi.getServerSpec(info.serverName, folder).then(s => s, () => undefined);
        password = serverSpec?.password;

        if (!password) {
          const account = serverSpec ? smApi.getAccount(serverSpec) : undefined;
          const scopes = [info.serverName, info.username ?? ''];
          const session = await vscode.authentication
            .getSession(SM_AUTH_PROVIDER_ID, scopes, { silent: true, account })
            .then(s => s, () => undefined);
          password = session?.accessToken;
        }
      }

      return {
        serverName: info.serverName,
        host: info.host,
        port: info.port,
        scheme: info.scheme || 'http',
        pathPrefix: info.pathPrefix || '',
        ns: (info.namespace || 'USER').toUpperCase(),
        username: info.username || '_SYSTEM',
        password: password ?? '',
      };
    } catch {
      continue;
    }
  }

  return undefined;
}

