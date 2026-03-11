import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { getConnection } from '../../IrisConnectionService';

// ---------------------------------------------------------------------------
// Helper: stub vscode.workspace.getConfiguration for 'objectscript'
// ---------------------------------------------------------------------------

function stubObjectScriptConn(
  sandbox: sinon.SinonSandbox,
  connValue: unknown,
): void {
  sandbox.stub(vscode.workspace, 'getConfiguration').callsFake(() => ({
    get: (key: string) => (key === 'conn' ? connValue : undefined),
    has: () => false,
    inspect: () => undefined,
    update: async () => undefined,
  } as unknown as vscode.WorkspaceConfiguration));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('IrisConnectionService > getConnection', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => sandbox.restore());

  // ── inactive connection ────────────────────────────────────────────────────

  test('returns undefined when conn.active is false and Server Manager absent', async () => {
    stubObjectScriptConn(sandbox, { active: false, host: 'localhost', port: 52773 });
    sandbox.stub(vscode.extensions, 'getExtension').returns(undefined);

    const result = await getConnection();
    assert.strictEqual(result, undefined);
  });

  test('returns undefined when conn is undefined and Server Manager absent', async () => {
    stubObjectScriptConn(sandbox, undefined);
    sandbox.stub(vscode.extensions, 'getExtension').returns(undefined);

    const result = await getConnection();
    assert.strictEqual(result, undefined);
  });

  // ── inline connection (host / port) ────────────────────────────────────────

  test('returns connection from inline host/port', async () => {
    stubObjectScriptConn(sandbox, {
      active: true, host: 'myserver', port: 52773, ns: 'MYNS', username: 'Admin', password: 'pass', https: false,
    });

    const result = await getConnection();
    assert.ok(result !== undefined);
    assert.strictEqual(result!.host, 'myserver');
    assert.strictEqual(result!.port, 52773);
    assert.strictEqual(result!.namespace, 'MYNS');
    assert.strictEqual(result!.username, 'Admin');
    assert.strictEqual(result!.password, 'pass');
    assert.strictEqual(result!.scheme, 'http');
  });

  test('uses https scheme when https is true', async () => {
    stubObjectScriptConn(sandbox, {
      active: true, host: 'secure.example.com', port: 443, ns: 'USER', username: 'Admin', password: 'pass', https: true,
    });

    const result = await getConnection();
    assert.ok(result !== undefined);
    assert.strictEqual(result!.scheme, 'https');
  });

  test('defaults namespace to USER when ns is absent', async () => {
    stubObjectScriptConn(sandbox, {
      active: true, host: 'localhost', port: 52773, username: '_SYSTEM', password: '',
    });

    const result = await getConnection();
    assert.ok(result !== undefined);
    assert.strictEqual(result!.namespace, 'USER');
  });

  test('uppercases namespace', async () => {
    stubObjectScriptConn(sandbox, {
      active: true, host: 'localhost', port: 52773, ns: 'myns', username: '_SYSTEM', password: '',
    });

    const result = await getConnection();
    assert.ok(result !== undefined);
    assert.strictEqual(result!.namespace, 'MYNS');
  });

  test('defaults username to _SYSTEM when absent', async () => {
    stubObjectScriptConn(sandbox, {
      active: true, host: 'localhost', port: 52773, ns: 'USER',
    });

    const result = await getConnection();
    assert.ok(result !== undefined);
    assert.strictEqual(result!.username, '_SYSTEM');
  });

  // ── active but no host or server → falls back to Server Manager ───────────

  test('returns undefined when active but no host/server and Server Manager absent', async () => {
    stubObjectScriptConn(sandbox, { active: true });
    sandbox.stub(vscode.extensions, 'getExtension').returns(undefined);

    const result = await getConnection();
    assert.strictEqual(result, undefined);
  });

  // ── named server via Server Manager API ────────────────────────────────────

  test('resolves named server via Server Manager API', async () => {
    stubObjectScriptConn(sandbox, { active: true, server: 'my-iris', ns: 'PROD' });

    const fakeSpec = {
      name: 'my-iris',
      webServer: { host: 'irishost', port: 52773, scheme: 'http', pathPrefix: '/iris' },
      username: 'SuperUser',
      password: 'secret',
    };
    const fakeApi = {
      getServerSpec: async (_name: string) => fakeSpec,
      getServerNames: () => [],
    };
    sandbox.stub(vscode.extensions, 'getExtension').returns({
      isActive: true,
      exports: fakeApi,
    } as never);

    const result = await getConnection();
    assert.ok(result !== undefined);
    assert.strictEqual(result!.serverName, 'my-iris');
    assert.strictEqual(result!.host, 'irishost');
    assert.strictEqual(result!.port, 52773);
    assert.strictEqual(result!.namespace, 'PROD');
    assert.strictEqual(result!.pathPrefix, '/iris');
    assert.strictEqual(result!.username, 'SuperUser');
  });

  test('returns undefined when named server spec not found in Server Manager', async () => {
    stubObjectScriptConn(sandbox, { active: true, server: 'missing-server', ns: 'USER' });

    const fakeApi = {
      getServerSpec: async (_name: string) => undefined,
      getServerNames: () => [],
    };
    sandbox.stub(vscode.extensions, 'getExtension').returns({
      isActive: true,
      exports: fakeApi,
    } as never);

    const result = await getConnection();
    assert.strictEqual(result, undefined);
  });

  test('activates Server Manager extension if not yet active', async () => {
    stubObjectScriptConn(sandbox, { active: true, server: 'my-iris', ns: 'USER' });

    const fakeSpec = {
      name: 'my-iris',
      webServer: { host: 'h', port: 52773, scheme: 'http', pathPrefix: '' },
      username: 'u', password: 'p',
    };
    const activated: string[] = [];
    const fakeExt = {
      isActive: false,
      activate: async () => { activated.push('activated'); fakeExt.isActive = true; },
      exports: { getServerSpec: async () => fakeSpec, getServerNames: () => [] },
    };
    sandbox.stub(vscode.extensions, 'getExtension').returns(fakeExt as never);

    await getConnection();
    assert.ok(activated.includes('activated'), 'activate() should have been called');
  });

  // ── credential overrides when using named server (fix for 401) ────────────

  test('overrides Server Manager credentials with username and password from conn config', async () => {
    stubObjectScriptConn(sandbox, {
      active: true, server: 'my-iris', ns: 'IRISAPP',
      username: 'SuperUser', password: 'SYS',
    });

    const fakeSpec = {
      name: 'my-iris',
      webServer: { host: 'irishost', port: 52773, scheme: 'http', pathPrefix: '' },
      username: 'OldUser', password: 'OldPass',
    };
    sandbox.stub(vscode.extensions, 'getExtension').returns({
      isActive: true,
      exports: { getServerSpec: async () => fakeSpec, getServerNames: () => [] },
    } as never);

    const result = await getConnection();
    assert.ok(result !== undefined);
    assert.strictEqual(result!.username, 'SuperUser', 'conn username should override spec username');
    assert.strictEqual(result!.password, 'SYS', 'conn password should override spec password');
    assert.strictEqual(result!.namespace, 'IRISAPP');
  });

  test('falls back to Server Manager credentials when conn omits username and password', async () => {
    stubObjectScriptConn(sandbox, { active: true, server: 'my-iris', ns: 'USER' });

    const fakeSpec = {
      name: 'my-iris',
      webServer: { host: 'irishost', port: 52773, scheme: 'http', pathPrefix: '' },
      username: 'SpecUser', password: 'SpecPass',
    };
    sandbox.stub(vscode.extensions, 'getExtension').returns({
      isActive: true,
      exports: { getServerSpec: async () => fakeSpec, getServerNames: () => [] },
    } as never);

    const result = await getConnection();
    assert.ok(result !== undefined);
    assert.strictEqual(result!.username, 'SpecUser', 'should use spec username when conn has none');
    assert.strictEqual(result!.password, 'SpecPass', 'should use spec password when conn has none');
  });

  test('allows overriding password with an empty string', async () => {
    stubObjectScriptConn(sandbox, {
      active: true, server: 'my-iris', ns: 'USER',
      username: 'Admin', password: '',
    });

    const fakeSpec = {
      name: 'my-iris',
      webServer: { host: 'irishost', port: 52773, scheme: 'http', pathPrefix: '' },
      username: 'Admin', password: 'ShouldBeIgnored',
    };
    sandbox.stub(vscode.extensions, 'getExtension').returns({
      isActive: true,
      exports: { getServerSpec: async () => fakeSpec, getServerNames: () => [] },
    } as never);

    const result = await getConnection();
    assert.ok(result !== undefined);
    assert.strictEqual(result!.password, '', 'explicit empty-string password in conn should be used');
  });
});
