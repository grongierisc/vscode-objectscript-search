import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  buildPath,
  search,
  _setTransport,
} from '../../IrisSearchService';
import type { IConnection } from '../../types';
import type { AtelierQueryResponse, RequestCapture } from '../../IrisSearchService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_CONN: IConnection = {
  host: 'localhost',
  port: 52773,
  scheme: 'http',
  pathPrefix: '',
  namespace: 'USER',
  username: '_SYSTEM',
  password: 'SYS',
};

interface CapturedCall {
  capture: RequestCapture;
  response: AtelierQueryResponse;
}

/** Install a fake transport that returns the given body and records calls. */
function installTransport(
  response: AtelierQueryResponse,
  calls: CapturedCall[] = [],
): CapturedCall[] {
  _setTransport(async (capture) => {
    calls.push({ capture, response });
    return response;
  });
  return calls;
}

/** Install a transport that returns successive responses per call. */
function installMultiTransport(responses: AtelierQueryResponse[]): CapturedCall[] {
  const calls: CapturedCall[] = [];
  let idx = 0;
  _setTransport(async (capture) => {
    const response = responses[idx] ?? responses[responses.length - 1];
    idx++;
    calls.push({ capture, response });
    return response;
  });
  return calls;
}

/** Install a transport that rejects with the given error. */
function installErrorTransport(error: Error): void {
  _setTransport(async () => { throw error; });
}

// ---------------------------------------------------------------------------
// Suite: buildPath
// ---------------------------------------------------------------------------

suite('IrisSearchService > buildPath', () => {
  test('builds v2 path without prefix', () => {
    const result = buildPath({ ...BASE_CONN, pathPrefix: '' }, '/action/search', 2);
    assert.strictEqual(result, '/api/atelier/v2/USER/action/search');
  });

  test('builds v2 path with prefix (no trailing slash)', () => {
    const result = buildPath({ ...BASE_CONN, pathPrefix: '/myapp' }, '/action/search', 2);
    assert.strictEqual(result, '/myapp/api/atelier/v2/USER/action/search');
  });

  test('strips trailing slash from prefix', () => {
    const result = buildPath({ ...BASE_CONN, pathPrefix: '/myapp/' }, '/action/search', 2);
    assert.strictEqual(result, '/myapp/api/atelier/v2/USER/action/search');
  });

  test('URL-encodes namespace', () => {
    const result = buildPath({ ...BASE_CONN, namespace: 'MY NS' }, '/action/search', 2);
    assert.strictEqual(result, '/api/atelier/v2/MY%20NS/action/search');
  });

  test('defaults to v1 when no version given', () => {
    const result = buildPath(BASE_CONN, '/docnames');
    assert.ok(result.includes('/api/atelier/v1/'));
  });
});

// ---------------------------------------------------------------------------
// Suite: search
// ---------------------------------------------------------------------------

suite('IrisSearchService > search', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (_key: string, def?: unknown) => def,
      has: () => false,
      inspect: () => undefined,
      update: async () => undefined,
    } as unknown as vscode.WorkspaceConfiguration);
  });

  teardown(() => {
    sandbox.restore();
    _setTransport(undefined);
  });

  test('makes a single GET request', async () => {
    const calls = installTransport({ result: [] });
    await search(BASE_CONN, { query: 'findme', categories: [], maxResults: 10, includeSystem: false });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].capture.method, 'GET');
  });

  test('sends query as URL parameter on v2 path', async () => {
    const calls = installTransport({ result: [] });
    await search(BASE_CONN, { query: 'findme', categories: ['CLS'], maxResults: 10, includeSystem: false });
    assert.ok(calls[0].capture.path.includes('/api/atelier/v2/'));
    assert.ok(calls[0].capture.path.includes(`query=${encodeURIComponent('findme')}`));
  });

  test('includes only *.cls mask when CLS category selected', async () => {
    const calls = installTransport({ result: [] });
    await search(BASE_CONN, { query: 'q', categories: ['CLS'], maxResults: 10, includeSystem: false });
    assert.ok(calls[0].capture.path.includes(encodeURIComponent('*.cls')));
    assert.ok(!calls[0].capture.path.includes(encodeURIComponent('*.mac')));
  });

  test('includes all masks when categories empty', async () => {
    const calls = installTransport({ result: [] });
    await search(BASE_CONN, { query: 'q', categories: [], maxResults: 10, includeSystem: false });
    const path = calls[0].capture.path;
    assert.ok(path.includes(encodeURIComponent('*.cls')));
    assert.ok(path.includes(encodeURIComponent('*.mac')));
  });

  test('passes sys=0 when includeSystem is false', async () => {
    const calls = installTransport({ result: [] });
    await search(BASE_CONN, { query: 'q', categories: [], maxResults: 10, includeSystem: false });
    assert.ok(calls[0].capture.path.includes('sys=0'));
  });

  test('passes sys=1 when includeSystem is true', async () => {
    const calls = installTransport({ result: [] });
    await search(BASE_CONN, { query: 'q', categories: [], maxResults: 10, includeSystem: true });
    assert.ok(calls[0].capture.path.includes('sys=1'));
  });

  test('passes gen=0 when includeGenerated is omitted', async () => {
    const calls = installTransport({ result: [] });
    await search(BASE_CONN, { query: 'q', categories: [], maxResults: 10, includeSystem: false });
    assert.ok(calls[0].capture.path.includes('gen=0'));
  });

  test('passes gen=1 when includeGenerated is true', async () => {
    const calls = installTransport({ result: [] });
    await search(BASE_CONN, { query: 'q', categories: [], maxResults: 10, includeSystem: false, includeGenerated: true });
    assert.ok(calls[0].capture.path.includes('gen=1'));
  });

  test('includes Basic auth header', async () => {
    const calls = installTransport({ result: [] });
    await search(BASE_CONN, { query: 'x', categories: [], maxResults: 10, includeSystem: false });
    const expected = 'Basic ' + Buffer.from('_SYSTEM:SYS').toString('base64');
    assert.strictEqual(calls[0].capture.headers['Authorization'], expected);
  });

  test('returns class match grouped by file with matches array', async () => {
    installTransport({
      result: [
        { doc: 'My.Package.ClassName.cls', matches: [{ member: 'MyMethod', text: 'findme here' }] },
      ],
    });
    const results = await search(BASE_CONN, { query: 'findme', categories: ['CLS'], maxResults: 10, includeSystem: false });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].name, 'My.Package.ClassName.cls');
    assert.strictEqual(results[0].category, 'CLS');
    assert.strictEqual(results[0].matches.length, 1);
    assert.strictEqual(results[0].matches[0].member, 'MyMethod');
    assert.ok(results[0].matches[0].text.includes('findme'));
  });

  test('returns routine match with MAC category', async () => {
    installTransport({
      result: [
        { doc: 'MyRoutine.mac', matches: [{ line: '42', text: 'do findme' }] },
      ],
    });
    const results = await search(BASE_CONN, { query: 'findme', categories: ['RTN'], maxResults: 10, includeSystem: false });
    assert.strictEqual(results[0].name, 'MyRoutine.mac');
    assert.strictEqual(results[0].category, 'MAC');
    assert.strictEqual(results[0].matches[0].line, '42');
  });

  test('groups multiple matches per file under one result entry', async () => {
    installTransport({
      result: [{
        doc: 'Foo.cls',
        matches: [
          { member: 'MethodA', text: 'hit one' },
          { member: 'MethodB', text: 'hit two' },
        ],
      }],
    });
    const results = await search(BASE_CONN, { query: 'hit', categories: ['CLS'], maxResults: 10, includeSystem: false });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].matches.length, 2);
  });

  test('returns results for multiple files', async () => {
    installTransport({
      result: [
        { doc: 'My.Class.cls', matches: [{ member: 'Init', text: 'findme here' }] },
        { doc: 'MyRoutine.mac', matches: [{ line: '10', text: 'findme too' }] },
      ],
    });
    const results = await search(BASE_CONN, { query: 'findme', categories: [], maxResults: 10, includeSystem: false });
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].name, 'My.Class.cls');
    assert.strictEqual(results[1].name, 'MyRoutine.mac');
  });

  test('returns empty array and does not throw on transport error', async () => {
    installErrorTransport(new Error('ECONNREFUSED'));
    const results = await search(BASE_CONN, { query: 'q', categories: ['CLS'], maxResults: 10, includeSystem: false });
    assert.deepStrictEqual(results, []);
  });
});
