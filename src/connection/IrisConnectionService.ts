import * as vscode from 'vscode';
import type { IConnection } from '../types';
import { AUTHENTICATION_PROVIDER as SM_AUTH_PROVIDER_ID } from '@intersystems-community/intersystems-servermanager';

const OBJECTSCRIPT_EXT_ID = 'intersystems-community.vscode-objectscript';

/** Error message shown when no active ObjectScript connection is found. */
export const NO_CONNECTION_MSG =
  'No active ObjectScript connection found.\n\n' +
  'Add a server in "intersystems.servers" and set "objectscript.conn" in your workspace settings.';

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
 * For named servers, `asyncServerForUri` intentionally omits passwords stored
 * in the OS keychain. We retrieve them via the Server Manager auth provider,
 * prompting the user if no cached session exists — mirroring what
 * vscode-objectscript itself does in `resolvePassword()`.
 *
 * The returned `IConnection` includes `wsFolderName` so callers don't need
 * a separate workspace-folder scan.
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

      // Named servers store their password in the OS keychain. asyncServerForUri
      // intentionally omits it (only exposes passwords already in plaintext
      // settings). Use the Server Manager auth provider to retrieve it, prompting
      // if no cached session exists — same two-step approach as vscode-objectscript.
      if (!password && info.serverName) {
        const scopes = [info.serverName, info.username ?? ''];

        let session = await vscode.authentication
          .getSession(SM_AUTH_PROVIDER_ID, scopes, { silent: true })
          .then(s => s, () => undefined);

        if (!session) {
          session = await vscode.authentication
            .getSession(SM_AUTH_PROVIDER_ID, scopes, { createIfNone: true })
            .then(s => s, () => undefined);
        }

        password = session?.accessToken;
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
        wsFolderName: folder.name,
      };
    } catch {
      continue;
    }
  }

  return undefined;
}

/**
 * Returns every active IRIS connection in the workspace (one per active folder).
 * Used by the search command to offer a namespace picker when multiple folders
 * are connected to different servers / namespaces.
 */
export async function getAllConnections(): Promise<IConnection[]> {
  const ext = vscode.extensions.getExtension<ObjectScriptExtAPI>(OBJECTSCRIPT_EXT_ID);
  if (!ext) { return []; }
  if (!ext.isActive) { await ext.activate(); }

  const api = ext.exports;
  const connections: IConnection[] = [];

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const conn = vscode.workspace
      .getConfiguration('objectscript', folder)
      .get<Record<string, unknown>>('conn');
    if (conn?.active !== true) { continue; }

    try {
      const info = await api.asyncServerForUri(folder.uri);
      if (!info.active || !info.host || !info.port) { continue; }

      let password = info.password;

      if (!password && info.serverName) {
        const scopes = [info.serverName, info.username ?? ''];

        let session = await vscode.authentication
          .getSession(SM_AUTH_PROVIDER_ID, scopes, { silent: true })
          .then(s => s, () => undefined);

        if (!session) {
          session = await vscode.authentication
            .getSession(SM_AUTH_PROVIDER_ID, scopes, { createIfNone: true })
            .then(s => s, () => undefined);
        }

        password = session?.accessToken;
      }

      connections.push({
        serverName: info.serverName,
        host: info.host,
        port: info.port,
        scheme: info.scheme || 'http',
        pathPrefix: info.pathPrefix || '',
        ns: (info.namespace || 'USER').toUpperCase(),
        username: info.username || '_SYSTEM',
        password: password ?? '',
        wsFolderName: folder.name,
      });
    } catch {
      continue;
    }
  }

  return connections;
}
