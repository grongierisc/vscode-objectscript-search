import * as assert from 'assert';
import * as http from 'http';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  buildPath,
  extractSnippet,
  isCategoryMatch,
  searchByName,
  searchByContent,
} from '../../IrisSearchService';
import type { IConnection } from '../../types';

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

/** Returns a sinon stub on http.request that resolves with the given JSON body. */
function stubHttpResponse(
  sandbox: sinon.SinonSandbox,
  responseBody: unknown,
  statusCode = 200,
): sinon.SinonStub {
  const mockRes = {
    statusCode,
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === 'data') cb(Buffer.from(JSON.stringify(responseBody)));
      if (event === 'end') cb();
      return this;
    },
  };
  const mockReq = {
    on() { return this; },
    write() {},
    end() {},
  };
  const stub = sandbox.stub(http, 'request') as sinon.SinonStub;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stub.callsFake((_opts: any, cb: any) => { if (cb) cb(mockRes); return mockReq; });
  return stub;
}

/** Returns a sinon stub on http.request that emits a network error. */
function stubHttpError(sandbox: sinon.SinonSandbox, error: Error): sinon.SinonStub {
  const mockReq = {
    on(event: string, cb: (err: Error) => void) {
      if (event === 'error') cb(error);
      return this;
    },
    write() {},
    end() {},
  };
  const stub = sandbox.stub(http, 'request') as sinon.SinonStub;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stub.callsFake((_opts: any) => mockReq);
  return stub;
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
    // Stub VS Code config used by makeRequest
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (_key: string, def?: unknown) => def,
      has: () => false,
      inspect: () => undefined,
      update: async () => undefined,
    } as unknown as vscode.WorkspaceConfiguration);
  });

  teardown(() => sandbox.restore());

  test('wraps query with wildcards when no * present', async () => {
    const stub = stubHttpResponse(sandbox, { result: { content: [] } });
    await searchByName(BASE_CONN, {
      query: 'MyClass', searchType: 'name', categories: [], maxResults: 10, includeSystem: false,
    });
    const callPath: string = stub.firstCall.args[0].path;
    assert.ok(callPath.includes(encodeURIComponent('*MyClass*')), `path was: ${callPath}`);
  });

  test('does not add wildcards when query already contains *', async () => {
    const stub = stubHttpResponse(sandbox, { result: { content: [] } });
    await searchByName(BASE_CONN, {
      query: 'My*Class', searchType: 'name', categories: [], maxResults: 10, includeSystem: false,
    });
    const callPath: string = stub.firstCall.args[0].path;
    assert.ok(callPath.includes(encodeURIComponent('My*Class')));
    assert.ok(!callPath.includes(encodeURIComponent('*My*Class*')));
  });

  test('passes system=0 when includeSystem is false', async () => {
    const stub = stubHttpResponse(sandbox, { result: { content: [] } });
    await searchByName(BASE_CONN, {
      query: 'x', searchType: 'name', categories: [], maxResults: 10, includeSystem: false,
    });
    assert.ok((stub.firstCall.args[0].path as string).includes('system=0'));
  });

  test('passes system=1 when includeSystem is true', async () => {
    const stub = stubHttpResponse(sandbox, { result: { content: [] } });
    await searchByName(BASE_CONN, {
      query: 'x', searchType: 'name', categories: [], maxResults: 10, includeSystem: true,
    });
    assert.ok((stub.firstCall.args[0].path as string).includes('system=1'));
  });

  test('filters results by category', async () => {
    stubHttpResponse(sandbox, {
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
    stubHttpResponse(sandbox, {
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
    stubHttpResponse(sandbox, {
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
    const stub = stubHttpResponse(sandbox, { result: { content: [] } });
    await searchByName(BASE_CONN, {
      query: 'x', searchType: 'name', categories: [], maxResults: 10, includeSystem: false,
    });
    assert.strictEqual(stub.firstCall.args[0].method, 'GET');
  });

  test('includes Basic auth header', async () => {
    const stub = stubHttpResponse(sandbox, { result: { content: [] } });
    await searchByName(BASE_CONN, {
      query: 'x', searchType: 'name', categories: [], maxResults: 10, includeSystem: false,
    });
    const expected = 'Basic ' + Buffer.from('_SYSTEM:SYS').toString('base64');
    assert.strictEqual(stub.firstCall.args[0].headers['Authorization'], expected);
  });

  test('rejects on HTTP network error', async () => {
    stubHttpError(sandbox, new Error('ECONNREFUSED'));
    await assert.rejects(
      searchByName(BASE_CONN, {
        query: 'x', searchType: 'name', categories: [], maxResults: 10, includeSystem: false,
      }),
      /ECONNREFUSED/,
    );
  });

  test('rejects on non-2xx HTTP status', async () => {
    stubHttpResponse(sandbox, { error: 'Unauthorized' }, 401);
    await assert.rejects(
      searchByName(BASE_CONN, {
        query: 'x', searchType: 'name', categories: [], maxResults: 10, includeSystem: false,
      }),
      /HTTP 401/,
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

  teardown(() => sandbox.restore());

  test('makes two POST requests when no category filter (classes + routines)', async () => {
    const stub = stubHttpResponse(sandbox, { result: { content: [] } });
    await searchByContent(BASE_CONN, {
      query: 'findme', searchType: 'content', categories: [], maxResults: 10, includeSystem: false,
    });
    assert.strictEqual(stub.callCount, 2);
  });

  test('makes only one request when only CLS selected', async () => {
    const stub = stubHttpResponse(sandbox, { result: { content: [] } });
    await searchByContent(BASE_CONN, {
      query: 'findme', searchType: 'content', categories: ['CLS'], maxResults: 10, includeSystem: false,
    });
    assert.strictEqual(stub.callCount, 1);
  });

  test('makes only one request when only RTN selected', async () => {
    const stub = stubHttpResponse(sandbox, { result: { content: [] } });
    await searchByContent(BASE_CONN, {
      query: 'findme', searchType: 'content', categories: ['RTN'], maxResults: 10, includeSystem: false,
    });
    assert.strictEqual(stub.callCount, 1);
  });

  test('uses POST method for query requests', async () => {
    const stub = stubHttpResponse(sandbox, { result: { content: [] } });
    await searchByContent(BASE_CONN, {
      query: 'q', searchType: 'content', categories: ['CLS'], maxResults: 10, includeSystem: false,
    });
    assert.strictEqual(stub.firstCall.args[0].method, 'POST');
  });

  test('returns class results with .cls extension', async () => {
    stubHttpResponse(sandbox, {
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
    stubHttpResponse(sandbox, {
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
    stubHttpResponse(sandbox, {
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
    stubHttpResponse(sandbox, {
      result: { content: [{ name: 'MyRoutine', type: 'INT' }] },
    });
    const results = await searchByContent(BASE_CONN, {
      query: 'q', searchType: 'content', categories: ['RTN'], maxResults: 10, includeSystem: false,
    });
    assert.strictEqual(results[0].name, 'MyRoutine.int');
  });

  test('defaults extension to .mac when type is missing', async () => {
    stubHttpResponse(sandbox, {
      result: { content: [{ name: 'OldRoutine' }] },
    });
    const results = await searchByContent(BASE_CONN, {
      query: 'q', searchType: 'content', categories: ['RTN'], maxResults: 10, includeSystem: false,
    });
    assert.ok(results[0].name.endsWith('.mac'));
  });

  test('returns empty array and does not throw on HTTP error (class search)', async () => {
    stubHttpError(sandbox, new Error('ECONNREFUSED'));
    const results = await searchByContent(BASE_CONN, {
      query: 'q', searchType: 'content', categories: ['CLS'], maxResults: 10, includeSystem: false,
    });
    assert.deepStrictEqual(results, []);
  });
});
