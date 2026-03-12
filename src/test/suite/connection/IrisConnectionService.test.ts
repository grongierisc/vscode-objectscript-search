import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { getConnection } from '../../../connection/IrisConnectionService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake asyncServerForUri result. */
function makeServerInfo(overrides: Partial<{
  serverName: string;
  active: boolean;
  scheme: string;
  host: string;
  port: number;
  pathPrefix: string;
  username: string;
  password: string | undefined;
  namespace: string;
}> = {}) {
  return {
    serverName: undefined as string | undefined,
    active: true,
    scheme: 'http',
    host: 'localhost',
    port: 52773,
    pathPrefix: '',
    username: '_SYSTEM',
    password: 'SYS' as string | undefined,
    namespace: 'USER',
    ...overrides,
  };
}

/**
 * Stub workspace folders + objectscript.conn + the vscode-objectscript extension.
 */
function setupEnv(
  sandbox: sinon.SinonSandbox,
  opts: {
    connActive?: boolean;
    serverInfo?: ReturnType<typeof makeServerInfo> | Error;
  } = {},
): void {
  const connActive = opts.connActive ?? true;
  const fakeFolder: vscode.WorkspaceFolder = {
    index: 0,
    name: 'myFolder',
    uri: vscode.Uri.file('/fake'),
  };

  sandbox.stub(vscode.workspace, 'workspaceFolders').get(() => [fakeFolder]);
  sandbox.stub(vscode.workspace, 'getConfiguration').callsFake(() => ({
    get: (key: string) => (key === 'conn' ? { active: connActive } : undefined),
    has: () => false,
    inspect: () => undefined,
    update: async () => undefined,
  } as unknown as vscode.WorkspaceConfiguration));

  const asyncServerForUri = opts.serverInfo instanceof Error
    ? sinon.stub().rejects(opts.serverInfo)
    : sinon.stub().resolves(opts.serverInfo ?? makeServerInfo());

  sandbox.stub(vscode.extensions, 'getExtension').returns({
    isActive: true,
    exports: { asyncServerForUri },
  } as never);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('IrisConnectionService > getConnection', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => sandbox.restore());

  // ── extension not installed ────────────────────────────────────────────────

  test('returns undefined when vscode-objectscript is not installed', async () => {
    sandbox.stub(vscode.workspace, 'workspaceFolders').get(() => []);
    sandbox.stub(vscode.extensions, 'getExtension').returns(undefined);

    assert.strictEqual(await getConnection(), undefined);
  });

  // ── no workspace folders ──────────────────────────────────────────────────

  test('returns undefined when there are no workspace folders', async () => {
    sandbox.stub(vscode.workspace, 'workspaceFolders').get(() => []);
    sandbox.stub(vscode.extensions, 'getExtension').returns({
      isActive: true,
      exports: { asyncServerForUri: sinon.stub() },
    } as never);

    assert.strictEqual(await getConnection(), undefined);
  });

  // ── conn.active false ──────────────────────────────────────────────────────

  test('returns undefined when conn.active is false', async () => {
    setupEnv(sandbox, { connActive: false });
    assert.strictEqual(await getConnection(), undefined);
  });

  // ── basic connection ──────────────────────────────────────────────────────

  test('returns IConnection from asyncServerForUri result', async () => {
    setupEnv(sandbox, {
      serverInfo: makeServerInfo({
        host: 'irishost', port: 52773, namespace: 'PROD',
        username: 'Admin', password: 'pass', scheme: 'http', pathPrefix: '',
      }),
    });

    const result = await getConnection();
    assert.ok(result !== undefined);
    assert.strictEqual(result!.host, 'irishost');
    assert.strictEqual(result!.port, 52773);
    assert.strictEqual(result!.ns, 'PROD');
    assert.strictEqual(result!.username, 'Admin');
    assert.strictEqual(result!.password, 'pass');
    assert.strictEqual(result!.scheme, 'http');
    assert.strictEqual(result!.pathPrefix, '');
  });

  test('uses https scheme', async () => {
    setupEnv(sandbox, { serverInfo: makeServerInfo({ scheme: 'https', host: 'secure.example.com', port: 443 }) });
    const result = await getConnection();
    assert.strictEqual(result?.scheme, 'https');
  });

  test('uppercases namespace', async () => {
    setupEnv(sandbox, { serverInfo: makeServerInfo({ namespace: 'myns' }) });
    const result = await getConnection();
    assert.strictEqual(result?.ns, 'MYNS');
  });

  test('defaults namespace to USER when empty', async () => {
    setupEnv(sandbox, { serverInfo: makeServerInfo({ namespace: '' }) });
    const result = await getConnection();
    assert.strictEqual(result?.ns, 'USER');
  });

  test('defaults username to _SYSTEM when absent in result', async () => {
    setupEnv(sandbox, { serverInfo: makeServerInfo({ username: '' }) });
    const result = await getConnection();
    assert.strictEqual(result?.username, '_SYSTEM');
  });

  test('populates wsFolderName from the active workspace folder', async () => {
    setupEnv(sandbox, { serverInfo: makeServerInfo() });
    const result = await getConnection();
    assert.strictEqual(result?.wsFolderName, 'myFolder');
  });

  // ── inactive connection in result ─────────────────────────────────────────

  test('returns undefined when asyncServerForUri reports active:false', async () => {
    setupEnv(sandbox, { serverInfo: makeServerInfo({ active: false }) });
    assert.strictEqual(await getConnection(), undefined);
  });

  test('returns undefined when asyncServerForUri reports empty host', async () => {
    setupEnv(sandbox, { serverInfo: makeServerInfo({ host: '' }) });
    assert.strictEqual(await getConnection(), undefined);
  });

  // ── named server: password via auth provider ──────────────────────────────

  test('uses silent auth session to get keychain password for named server', async () => {
    setupEnv(sandbox, {
      serverInfo: makeServerInfo({ serverName: 'my-iris', username: 'SuperUser', password: undefined }),
    });
    sandbox.stub(vscode.authentication, 'getSession').resolves({
      id: '1', accessToken: 'keychainSecret',
      account: { id: 'SuperUser', label: 'SuperUser' }, scopes: ['my-iris', 'SuperUser'],
    });

    const result = await getConnection();
    assert.ok(result !== undefined);
    assert.strictEqual(result!.serverName, 'my-iris');
    assert.strictEqual(result!.username, 'SuperUser');
    assert.strictEqual(result!.password, 'keychainSecret');
  });

  test('falls back to createIfNone:true when silent session returns null', async () => {
    setupEnv(sandbox, {
      serverInfo: makeServerInfo({ serverName: 'my-iris', username: 'Admin', password: undefined }),
    });

    const getSessionStub = sandbox.stub(vscode.authentication, 'getSession');
    getSessionStub.onFirstCall().resolves(null as never);
    getSessionStub.onSecondCall().resolves({
      id: '2', accessToken: 'promptedSecret',
      account: { id: 'Admin', label: 'Admin' }, scopes: ['my-iris', 'Admin'],
    });

    const result = await getConnection();
    assert.ok(result !== undefined);
    assert.strictEqual(result!.password, 'promptedSecret');
    assert.ok(getSessionStub.calledTwice, 'should call getSession twice');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const allArgs = getSessionStub.args as any[][];
    assert.strictEqual(allArgs[0][2].silent, true);
    assert.strictEqual(allArgs[1][2].createIfNone, true);
  });

  test('does not call createIfNone when silent session succeeds', async () => {
    setupEnv(sandbox, {
      serverInfo: makeServerInfo({ serverName: 'my-iris', password: undefined }),
    });
    const getSessionStub = sandbox.stub(vscode.authentication, 'getSession').resolves({
      id: '1', accessToken: 'cachedTok',
      account: { id: 'u', label: 'u' }, scopes: [],
    });

    const result = await getConnection();
    assert.ok(result !== undefined);
    assert.strictEqual(result!.password, 'cachedTok');
    assert.ok(getSessionStub.calledOnce, 'should only call getSession once when silent succeeds');
  });

  test('returns empty password when both getSession calls return nothing', async () => {
    setupEnv(sandbox, {
      serverInfo: makeServerInfo({ serverName: 'my-iris', password: undefined }),
    });
    sandbox.stub(vscode.authentication, 'getSession').resolves(null as never);

    const result = await getConnection();
    assert.ok(result !== undefined);
    assert.strictEqual(result!.password, '');
  });

  test('does not call auth provider when password is already set', async () => {
    setupEnv(sandbox, { serverInfo: makeServerInfo({ password: 'alreadySet' }) });
    const authSpy = sandbox.stub(vscode.authentication, 'getSession');

    await getConnection();
    assert.ok(!authSpy.called, 'getSession should not be called when password is already present');
  });

  // ── extension activation ──────────────────────────────────────────────────

  test('activates vscode-objectscript extension if not yet active', async () => {
    const asyncServerForUri = sinon.stub().resolves(makeServerInfo());
    const activated: string[] = [];
    const fakeExt = {
      isActive: false,
      activate: async () => { activated.push('activated'); fakeExt.isActive = true; },
      exports: { asyncServerForUri },
    };

    const fakeFolder: vscode.WorkspaceFolder = { index: 0, name: 'ws', uri: vscode.Uri.file('/f') };
    sandbox.stub(vscode.workspace, 'workspaceFolders').get(() => [fakeFolder]);
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (key: string) => key === 'conn' ? { active: true } : undefined,
      has: () => false, inspect: () => undefined, update: async () => undefined,
    } as unknown as vscode.WorkspaceConfiguration);
    sandbox.stub(vscode.extensions, 'getExtension').returns(fakeExt as never);

    await getConnection();
    assert.ok(activated.includes('activated'), 'activate() should have been called');
  });

  // ── error handling ────────────────────────────────────────────────────────

  test('returns undefined when asyncServerForUri throws', async () => {
    setupEnv(sandbox, { serverInfo: new Error('connection refused') });
    assert.strictEqual(await getConnection(), undefined);
  });

  test('returns empty password when auth provider call throws', async () => {
    setupEnv(sandbox, {
      serverInfo: makeServerInfo({ serverName: 'my-iris', password: undefined }),
    });
    sandbox.stub(vscode.authentication, 'getSession').rejects(new Error('provider unavailable'));

    const result = await getConnection();
    assert.ok(result !== undefined);
    assert.strictEqual(result!.password, '');
  });

  // ── port validation ───────────────────────────────────────────────────────

  test('returns undefined when asyncServerForUri reports port 0', async () => {
    setupEnv(sandbox, { serverInfo: makeServerInfo({ port: 0 }) });
    assert.strictEqual(await getConnection(), undefined);
  });

  // ── pathPrefix preserved ──────────────────────────────────────────────────

  test('preserves pathPrefix from asyncServerForUri result', async () => {
    setupEnv(sandbox, { serverInfo: makeServerInfo({ pathPrefix: '/api/atelier' }) });
    const result = await getConnection();
    assert.strictEqual(result?.pathPrefix, '/api/atelier');
  });

  // ── serverName preserved ──────────────────────────────────────────────────

  test('preserves serverName in returned IConnection', async () => {
    setupEnv(sandbox, { serverInfo: makeServerInfo({ serverName: 'prod-iris', password: 'p' }) });
    const result = await getConnection();
    assert.strictEqual(result?.serverName, 'prod-iris');
  });

  // ── asyncServerForUri receives correct URI ────────────────────────────────

  test('calls asyncServerForUri with the workspace folder URI', async () => {
    const fakeUri = vscode.Uri.file('/my-workspace');
    const fakeFolder: vscode.WorkspaceFolder = { index: 0, name: 'ws', uri: fakeUri };
    const asyncServerForUri = sinon.stub().resolves(makeServerInfo());

    sandbox.stub(vscode.workspace, 'workspaceFolders').get(() => [fakeFolder]);
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (key: string) => key === 'conn' ? { active: true } : undefined,
      has: () => false, inspect: () => undefined, update: async () => undefined,
    } as unknown as vscode.WorkspaceConfiguration);
    sandbox.stub(vscode.extensions, 'getExtension').returns(
      { isActive: true, exports: { asyncServerForUri } } as never
    );

    await getConnection();
    assert.ok(asyncServerForUri.calledOnceWith(fakeUri), 'asyncServerForUri must receive the folder URI');
  });

  // ── multiple workspace folders ────────────────────────────────────────────

  function makeFolder(name: string, path: string): vscode.WorkspaceFolder {
    return { index: 0, name, uri: vscode.Uri.file(path) };
  }

  function stubMultiFolderEnv(
    sandbox: sinon.SinonSandbox,
    folders: vscode.WorkspaceFolder[],
    connActiveByName: Record<string, boolean>,
    serverInfoByName: Record<string, ReturnType<typeof makeServerInfo> | Error>,
  ): void {
    sandbox.stub(vscode.workspace, 'workspaceFolders').get(() => folders);
    sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((_section, scope) => {
      const folder = scope as vscode.WorkspaceFolder;
      const active = connActiveByName[folder.name] ?? false;
      return {
        get: (key: string) => key === 'conn' ? { active } : undefined,
        has: () => false, inspect: () => undefined, update: async () => undefined,
      } as unknown as vscode.WorkspaceConfiguration;
    });
    const asyncServerForUri = sinon.stub().callsFake((uri: vscode.Uri) => {
      const folder = folders.find(f => f.uri.toString() === uri.toString());
      const info = folder ? serverInfoByName[folder.name] : undefined;
      if (info instanceof Error) return Promise.reject(info);
      return Promise.resolve(info ?? makeServerInfo());
    });
    sandbox.stub(vscode.extensions, 'getExtension').returns(
      { isActive: true, exports: { asyncServerForUri } } as never
    );
  }

  test('skips inactive folder and returns connection from second active folder', async () => {
    const folderA = makeFolder('folderA', '/a');
    const folderB = makeFolder('folderB', '/b');
    stubMultiFolderEnv(
      sandbox,
      [folderA, folderB],
      { folderA: false, folderB: true },
      { folderB: makeServerInfo({ host: 'hostB', port: 1972 }) },
    );

    const result = await getConnection();
    assert.strictEqual(result?.host, 'hostB');
    assert.strictEqual(result?.port, 1972);
  });

  test('returns undefined when all folders have conn.active:false', async () => {
    const folderA = makeFolder('folderA', '/a');
    const folderB = makeFolder('folderB', '/b');
    stubMultiFolderEnv(
      sandbox,
      [folderA, folderB],
      { folderA: false, folderB: false },
      {},
    );

    assert.strictEqual(await getConnection(), undefined);
  });

  test('falls back to next folder when first active folder throws', async () => {
    const folderA = makeFolder('folderA', '/a');
    const folderB = makeFolder('folderB', '/b');
    stubMultiFolderEnv(
      sandbox,
      [folderA, folderB],
      { folderA: true, folderB: true },
      {
        folderA: new Error('connect error'),
        folderB: makeServerInfo({ host: 'fallbackHost', port: 52773 }),
      },
    );

    const result = await getConnection();
    assert.strictEqual(result?.host, 'fallbackHost');
  });
});
