import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  buildPath,
  extractSnippet,
  isCategoryMatch,
  searchByName,
  searchByContent,
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
  test('builds path without prefix', () => {
    const result = buildPath({ ...BASE_CONN, pathPrefix: '' }, '/docnames');
    assert.strictEqual(result, '/api/atelier/v1/USER/docnames');
  });

  test('builds path with prefix (no trailing slash)', () => {
    const result = buildPath({ ...BASE_CONN, pathPrefix: '/myapp' }, '/docnames');
    assert.strictEqual(result, '/myapp/api/atelier/v1/USER/docnames');
  });

  test('strips trailing slash from prefix', () => {
    const result = buildPath({ ...BASE_CONN, pathPrefix: '/myapp/' }, '/docnames');
    assert.strictEqual(result, '/myapp/api/atelier/v1/USER/docnames');
  });

  test('URL-encodes namespace', () => {
    const result = buildPath({ ...BASE_CONN, namespace: 'MY NS' }, '/docnames');
    assert.strictEqual(result, '/api/atelier/v1/MY%20NS/docnames');
  });

  test('appends query string verbatim', () => {
    const result = buildPath(BASE_CONN, '/docnames?filter=*Foo*&system=0');
    assert.ok(result.endsWith('?filter=*Foo*&system=0'));
  });
});

// ---------------------------------------------------------------------------
// Suite: extractSnippet
// ---------------------------------------------------------------------------

suite('IrisSearchService > extractSnippet', () => {
  test('returns empty string when query is not found', () => {
    assert.strictEqual(extractSnippet('hello world', 'xyz'), '');
  });

  test('includes the matched text in the snippet', () => {
    assert.ok(extractSnippet('some content findme here', 'findme').includes('findme'));
  });

  test('is case-insensitive', () => {
    const snippet = extractSnippet('some FINDME content', 'findme');
    assert.ok(snippet.toLowerCase().includes('findme'));
  });

  test('replaces newlines with spaces', () => {
    const snippet = extractSnippet('line1\nFINDME\nline3', 'FINDME');
    assert.ok(!snippet.includes('\n'));
    assert.ok(!snippet.includes('\r'));
  });

  test('handles match at the very start of content', () => {
    const snippet = extractSnippet('findme at start', 'findme');
    assert.ok(snippet.startsWith('findme'));
  });

  test('handles match at the very end of content', () => {
    const snippet = extractSnippet('content ends with findme', 'findme');
    assert.ok(snippet.endsWith('findme'));
  });

  test('limits context to 30 characters on each side', () => {
    const padding = 'x'.repeat(100);
    const snippet = extractSnippet(`${padding}findme${padding}`, 'findme');
    assert.ok(snippet.length <= 30 + 'findme'.length + 30);
  });
});

// ---------------------------------------------------------------------------
// Suite: isCategoryMatch
// ---------------------------------------------------------------------------

suite('IrisSearchService > isCategoryMatch', () => {
  test('matches any category when categories array is empty', () => {
    assert.ok(isCategoryMatch('CLS', []));
    assert.ok(isCategoryMatch('MAC', []));
    assert.ok(isCategoryMatch('CSP', []));
  });

  test('matches exact category case-insensitively', () => {
    assert.ok(isCategoryMatch('cls', ['CLS']));
    assert.ok(isCategoryMatch('CLS', ['CLS']));
    assert.ok(isCategoryMatch('MAC', ['MAC']));
  });

  test('RTN matches mac', () => {
    assert.ok(isCategoryMatch('mac', ['RTN']));
  });

  test('RTN matches int', () => {
    assert.ok(isCategoryMatch('int', ['RTN']));
  });

  test('INC matches inc', () => {
    assert.ok(isCategoryMatch('inc', ['INC']));
  });

  test('PKG matches pkg', () => {
    assert.ok(isCategoryMatch('pkg', ['PKG']));
  });

  test('does not match unrelated category', () => {
    assert.ok(!isCategoryMatch('mac', ['CLS']));
    assert.ok(!isCategoryMatch('cls', ['INC']));
  });

  test('matches when one of multiple categories satisfies', () => {
    assert.ok(isCategoryMatch('cls', ['RTN', 'CLS']));
    assert.ok(isCategoryMatch('mac', ['CLS', 'RTN']));
  });
});

// ---------------------------------------------------------------------------
// Suite: searchByName
// ---------------------------------------------------------------------------

suite('IrisSearchService > searchByName', () => {
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

  test('wraps query with wildcards when no * present', async () => {
    const calls = installTransport({ result: { content: [] } });
    await searchByName(BASE_CONN, {
      query: 'MyClass', searchType: 'name', categories: [], maxResults: 10, includeSystem: false,
    });
    assert.ok(
      calls[0].capture.path.includes(encodeURIComponent('*MyClass*')),
      `path was: ${calls[0].capture.path}`,
    );
  });

  test('does not add wildcards when query already contains *', async () => {
    const calls = installTransport({ result: { content: [] } });
    await searchByName(BASE_CONN, {
      query: 'My*Class', searchType: 'name', categories: [], maxResults: 10, includeSystem: false,
    });
    assert.ok(calls[0].capture.path.includes(encodeURIComponent('My*Class')));
    assert.ok(!calls[0].capture.path.includes(encodeURIComponent('*My*Class*')));
  });

  test('passes system=0 when includeSystem is false', async () => {
    const calls = installTransport({ result: { content: [] } });
    await searchByName(BASE_CONN, {
      query: 'x', searchType: 'name', categories: [], maxResults: 10, includeSystem: false,
    });
    assert.ok(calls[0].capture.path.includes('system=0'));
  });

  test('passes system=1 when includeSystem is true', async () => {
    const calls = installTransport({ result: { content: [] } });
    await searchByName(BASE_CONN, {
      query: 'x', searchType: 'name', categories: [], maxResults: 10, includeSystem: true,
    });
    assert.ok(calls[0].capture.path.includes('system=1'));
  });

  test('filters results by category', async () => {
    installTransport({
      result: {
        content: [
          { name: 'My.Class.cls', cat: 'CLS' },
          { name: 'MyRoutine.mac', cat: 'MAC' },
        ],
      },
    });
    const results = await searchByName(BASE_CONN, {
      query: 'My', searchType: 'name', categories: ['CLS'], maxResults: 10, includeSystem: false,
    });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].name, 'My.Class.cls');
    assert.strictEqual(results[0].category, 'CLS');
  });

  test('returns all results when categories is empty', async () => {
    installTransport({
      result: {
        content: [
          { name: 'My.Class.cls', cat: 'CLS' },
          { name: 'MyRoutine.mac', cat: 'MAC' },
          { name: 'MyInclude.inc', cat: 'INC' },
        ],
      },
    });
    const results = await searchByName(BASE_CONN, {
      query: 'My', searchType: 'name', categories: [], maxResults: 10, includeSystem: false,
    });
    assert.strictEqual(results.length, 3);
  });

  test('respects maxResults', async () => {
    installTransport({
      result: {
        content: [
          { name: 'A.cls', cat: 'CLS' },
          { name: 'B.cls', cat: 'CLS' },
          { name: 'C.cls', cat: 'CLS' },
        ],
      },
    });
    const results = await searchByName(BASE_CONN, {
      query: 'x', searchType: 'name', categories: [], maxResults: 2, includeSystem: false,
    });
    assert.strictEqual(results.length, 2);
  });

  test('uses GET method for docnames request', async () => {
    const calls = installTransport({ result: { content: [] } });
    await searchByName(BASE_CONN, {
      query: 'x', searchType: 'name', categories: [], maxResults: 10, includeSystem: false,
    });
    assert.strictEqual(calls[0].capture.method, 'GET');
  });

  test('includes Basic auth header', async () => {
    const calls = installTransport({ result: { content: [] } });
    await searchByName(BASE_CONN, {
      query: 'x', searchType: 'name', categories: [], maxResults: 10, includeSystem: false,
    });
    const expected = 'Basic ' + Buffer.from('_SYSTEM:SYS').toString('base64');
    assert.strictEqual(calls[0].capture.headers['Authorization'], expected);
  });

  test('rejects on transport error', async () => {
    installErrorTransport(new Error('ECONNREFUSED'));
    await assert.rejects(
      searchByName(BASE_CONN, {
        query: 'x', searchType: 'name', categories: [], maxResults: 10, includeSystem: false,
      }),
      /ECONNREFUSED/,
    );
  });
});

// ---------------------------------------------------------------------------
// Suite: searchByContent
// ---------------------------------------------------------------------------

suite('IrisSearchService > searchByContent', () => {
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

  test('makes two POST requests when no category filter (classes + routines)', async () => {
    const calls = installTransport({ result: { content: [] } });
    await searchByContent(BASE_CONN, {
      query: 'findme', searchType: 'content', categories: [], maxResults: 10, includeSystem: false,
    });
    assert.strictEqual(calls.length, 2);
  });

  test('makes only one request when only CLS selected', async () => {
    const calls = installTransport({ result: { content: [] } });
    await searchByContent(BASE_CONN, {
      query: 'findme', searchType: 'content', categories: ['CLS'], maxResults: 10, includeSystem: false,
    });
    assert.strictEqual(calls.length, 1);
  });

  test('makes only one request when only RTN selected', async () => {
    const calls = installTransport({ result: { content: [] } });
    await searchByContent(BASE_CONN, {
      query: 'findme', searchType: 'content', categories: ['RTN'], maxResults: 10, includeSystem: false,
    });
    assert.strictEqual(calls.length, 1);
  });

  test('uses POST method for query requests', async () => {
    const calls = installTransport({ result: { content: [] } });
    await searchByContent(BASE_CONN, {
      query: 'q', searchType: 'content', categories: ['CLS'], maxResults: 10, includeSystem: false,
    });
    assert.strictEqual(calls[0].capture.method, 'POST');
  });

  test('sends query string in request body', async () => {
    const calls = installTransport({ result: { content: [] } });
    await searchByContent(BASE_CONN, {
      query: 'findme', searchType: 'content', categories: ['CLS'], maxResults: 10, includeSystem: false,
    });
    const body = JSON.parse(calls[0].capture.body ?? '{}');
    assert.ok(Array.isArray(body.parameters));
    assert.ok((body.parameters as unknown[]).includes('findme'));
  });

  test('returns class results with .cls extension', async () => {
    installTransport({
      result: {
        content: [{ ClassName: 'My.Package.ClassName', MemberName: 'MyMethod', Content: 'findme here' }],
      },
    });
    const results = await searchByContent(BASE_CONN, {
      query: 'findme', searchType: 'content', categories: ['CLS'], maxResults: 10, includeSystem: false,
    });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].name, 'My.Package.ClassName.cls');
    assert.strictEqual(results[0].category, 'CLS');
  });

  test('sets context snippet on class results', async () => {
    installTransport({
      result: {
        content: [{ ClassName: 'Foo.Bar', MemberName: 'DoSomething', Content: 'xxx findme yyy' }],
      },
    });
    const results = await searchByContent(BASE_CONN, {
      query: 'findme', searchType: 'content', categories: ['CLS'], maxResults: 10, includeSystem: false,
    });
    assert.ok(results[0].context?.includes('DoSomething'));
    assert.ok(results[0].context?.includes('findme'));
  });

  test('returns routine results with lowercase extension (.mac)', async () => {
    installTransport({
      result: { content: [{ name: 'MyRoutine', type: 'MAC' }] },
    });
    const results = await searchByContent(BASE_CONN, {
      query: 'q', searchType: 'content', categories: ['RTN'], maxResults: 10, includeSystem: false,
    });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].name, 'MyRoutine.mac');
    assert.strictEqual(results[0].category, 'MAC');
  });

  test('returns routine results with .int extension', async () => {
    installTransport({
      result: { content: [{ name: 'MyRoutine', type: 'INT' }] },
    });
    const results = await searchByContent(BASE_CONN, {
      query: 'q', searchType: 'content', categories: ['RTN'], maxResults: 10, includeSystem: false,
    });
    assert.strictEqual(results[0].name, 'MyRoutine.int');
  });

  test('defaults extension to .mac when type is missing', async () => {
    installTransport({
      result: { content: [{ name: 'OldRoutine' }] },
    });
    const results = await searchByContent(BASE_CONN, {
      query: 'q', searchType: 'content', categories: ['RTN'], maxResults: 10, includeSystem: false,
    });
    assert.ok(results[0].name.endsWith('.mac'));
  });

  test('returns empty array and does not throw on transport error (class search)', async () => {
    installErrorTransport(new Error('ECONNREFUSED'));
    const results = await searchByContent(BASE_CONN, {
      query: 'q', searchType: 'content', categories: ['CLS'], maxResults: 10, includeSystem: false,
    });
    assert.deepStrictEqual(results, []);
  });
});
