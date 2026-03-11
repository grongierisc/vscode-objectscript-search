import * as vscode from 'vscode';
import type { ServerManagerAPI, IServerSpec } from '@intersystems-community/intersystems-servermanager';
import type { IConnection } from './types';

const SERVER_MANAGER_EXT_ID = 'intersystems-community.servermanager';

/**
 * Resolves the active IRIS connection for the given workspace scope.
 *
 * Resolution order:
 *  1. `objectscript.conn` with a named server → resolved via Server Manager API
 *  2. `objectscript.conn` with inline host/port → used directly
 *  3. First server from Server Manager (prompts for credentials if needed)
 */
export async function getConnection(
  scope?: vscode.ConfigurationScope,
): Promise<IConnection | undefined> {
  const conn = vscode.workspace
    .getConfiguration('objectscript', scope)
    .get<Record<string, unknown>>('conn');

  if (conn?.active === true) {
    if (typeof conn.server === 'string' && conn.server) {
      return resolveNamedServer(
        conn.server,
        (conn.ns as string) || 'USER',
        scope,
        conn.username as string | undefined,
        conn.password as string | undefined,
      );
    }
    if (typeof conn.host === 'string' && conn.host) {
      return {
        host: conn.host,
        port: typeof conn.port === 'number' ? conn.port : 52773,
        scheme: conn.https === true ? 'https' : 'http',
        pathPrefix: '',
        namespace: ((conn.ns as string) || 'USER').toUpperCase(),
        username: (conn.username as string) || '_SYSTEM',
        password: (conn.password as string) || '',
      };
    }
  }

  return resolveFromServerManager(scope);
}

async function resolveNamedServer(
  serverName: string,
  namespace: string,
  scope?: vscode.ConfigurationScope,
  usernameOverride?: string,
  passwordOverride?: string,
): Promise<IConnection | undefined> {
  const api = await getServerManagerAPI();
  if (!api) {
    return undefined;
  }

  const spec = await api.getServerSpec(serverName, scope);
  if (!spec) {
    return undefined;
  }

  const base = specToConnection(spec, namespace);
  return {
    ...base,
    username: usernameOverride || base.username,
    password: passwordOverride !== undefined ? passwordOverride : base.password,
  };
}

async function resolveFromServerManager(
  scope?: vscode.ConfigurationScope,
): Promise<IConnection | undefined> {
  const api = await getServerManagerAPI();
  if (!api) {
    return undefined;
  }

  const serverNames = api.getServerNames(scope);
  if (serverNames.length === 0) {
    return undefined;
  }

  // Use first available server; Server Manager will prompt for credentials
  const spec = await api.getServerSpec(serverNames[0].name, scope);
  if (!spec) {
    return undefined;
  }

  const ns = vscode.workspace
    .getConfiguration('objectscript', scope)
    .get<Record<string, unknown>>('conn');
  const namespace = ((ns?.ns as string) || 'USER').toUpperCase();

  return specToConnection(spec, namespace);
}

async function getServerManagerAPI(): Promise<ServerManagerAPI | undefined> {
  const ext = vscode.extensions.getExtension<ServerManagerAPI>(SERVER_MANAGER_EXT_ID);
  if (!ext) {
    return undefined;
  }
  if (!ext.isActive) {
    await ext.activate();
  }
  return ext.exports;
}

function specToConnection(spec: IServerSpec, namespace: string): IConnection {
  return {
    serverName: spec.name,
    host: spec.webServer.host,
    port: spec.webServer.port,
    scheme: spec.webServer.scheme || 'http',
    pathPrefix: spec.webServer.pathPrefix || '',
    namespace: namespace.toUpperCase(),
    username: spec.username || '_SYSTEM',
    password: spec.password || '',
  };
}
