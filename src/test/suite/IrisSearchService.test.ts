import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  buildPath,
  search,
  searchStream,
  _setTransport,
} from '../../IrisSearchService';
import type { IConnection, ISearchResult } from '../../types';
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
        { doc: 'MyRoutine.mac', matches: [{ line: 42, text: 'do findme' }] },
      ],
    });
    const results = await search(BASE_CONN, { query: 'findme', categories: ['RTN'], maxResults: 10, includeSystem: false });
    assert.strictEqual(results[0].name, 'MyRoutine.mac');
    assert.strictEqual(results[0].category, 'MAC');
    assert.strictEqual(results[0].matches[0].line, 42);
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
        { doc: 'MyRoutine.mac', matches: [{ line: 10, text: 'findme too' }] },
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

// ---------------------------------------------------------------------------
// Suite: searchStream
// ---------------------------------------------------------------------------

suite('IrisSearchService > searchStream', () => {
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

  /** Collect all yielded batches from an async generator. */
  async function collect(gen: AsyncIterable<ISearchResult[]>): Promise<{ batches: ISearchResult[][], all: ISearchResult[] }> {
    const batches: ISearchResult[][] = [];
    for await (const batch of gen) { batches.push(batch); }
    return { batches, all: batches.flat() };
  }

  // ── v6 async path ─────────────────────────────────────────────────────────

  test('v6: POSTs to /work endpoint when apiVersion >= 6', async () => {
    const calls = installMultiTransport([
      { result: { content: { api: 6 } } },   // getApiVersion
      { location: 'USER/work/job1' },          // POST /work
      { result: [] },                          // GET /work/job1 (done)
    ]);
    await collect(searchStream(BASE_CONN, { query: 'x', categories: ['CLS'], maxResults: 10, includeSystem: false }));
    assert.strictEqual(calls[1].capture.method, 'POST');
    assert.ok(calls[1].capture.path.endsWith('/work'), `path was: ${calls[1].capture.path}`);
  });

  test('v6: POST body contains required search parameters', async () => {
    const calls = installMultiTransport([
      { result: { content: { api: 6 } } },
      { location: 'USER/work/job1' },
      { result: [] },
    ]);
    await collect(searchStream(BASE_CONN, {
      query: 'findme', categories: ['CLS'], maxResults: 50,
      includeSystem: true, includeGenerated: true,
    }));
    const body = JSON.parse(calls[1].capture.body!);
    assert.strictEqual(body.request, 'search');
    assert.strictEqual(body.query, 'findme');
    assert.ok(body.documents.includes('*.cls'), `documents was: ${body.documents}`);
    assert.strictEqual(body.max, 50);
    assert.strictEqual(body.system, true);
    assert.strictEqual(body.generated, true);
  });

  test('v6: yields results returned by the poll response', async () => {
    installMultiTransport([
      { result: { content: { api: 6 } } },
      { location: 'USER/work/job1' },
      { result: [{ doc: 'Foo.cls', matches: [{ member: 'Bar', text: 'findme' }] }] },
    ]);
    const { all } = await collect(searchStream(BASE_CONN, { query: 'findme', categories: ['CLS'], maxResults: 10, includeSystem: false }));
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].name, 'Foo.cls');
    assert.strictEqual(all[0].category, 'CLS');
    assert.strictEqual(all[0].matches[0].member, 'Bar');
  });

  test('v6: polls again when Retry-After header is present', async () => {
    const calls = installMultiTransport([
      { result: { content: { api: 6 } } },
      { location: 'USER/work/job1' },
      { result: [], retryafter: '0.05' },                                         // still running
      { result: [{ doc: 'Done.cls', matches: [{ text: 'x' }] }] },               // finished
    ]);
    await collect(searchStream(BASE_CONN, { query: 'x', categories: ['CLS'], maxResults: 10, includeSystem: false }));
    const polls = calls.filter(c => c.capture.method === 'GET' && c.capture.path.includes('/work/'));
    assert.strictEqual(polls.length, 2);
  });

  test('v6: yields one batch per non-empty poll', async () => {
    installMultiTransport([
      { result: { content: { api: 6 } } },
      { location: 'USER/work/job1' },
      { result: [{ doc: 'A.cls', matches: [{ text: 'hit' }] }], retryafter: '0.05' },
      { result: [{ doc: 'B.mac', matches: [{ text: 'hit' }] }] },
    ]);
    const { batches, all } = await collect(searchStream(BASE_CONN, { query: 'hit', categories: ['CLS'], maxResults: 10, includeSystem: false }));
    assert.strictEqual(batches.length, 2);
    assert.strictEqual(all[0].name, 'A.cls');
    assert.strictEqual(all[1].name, 'B.mac');
  });

  test('v6: skips empty intermediate polls silently', async () => {
    installMultiTransport([
      { result: { content: { api: 6 } } },
      { location: 'USER/work/job1' },
      { result: [], retryafter: '0.05' }, // empty + still running → no yield
      { result: [{ doc: 'C.cls', matches: [{ text: 'ok' }] }] },
    ]);
    const { batches } = await collect(searchStream(BASE_CONN, { query: 'ok', categories: ['CLS'], maxResults: 10, includeSystem: false }));
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0][0].name, 'C.cls');
  });

  // ── v1–v5 per-mask fallback ───────────────────────────────────────────────

  test('v3: falls back to per-mask GET /action/search requests', async () => {
    const calls = installMultiTransport([
      { result: { content: { api: 3 } } },
      { result: [{ doc: 'Foo.cls', matches: [{ text: 'x' }] }] },
    ]);
    await collect(searchStream(BASE_CONN, { query: 'x', categories: ['CLS'], maxResults: 10, includeSystem: false }));
    assert.strictEqual(calls[1].capture.method, 'GET');
    assert.ok(calls[1].capture.path.includes('/action/search'), `path: ${calls[1].capture.path}`);
  });

  test('v3: sends one request per mask', async () => {
    const calls = installMultiTransport([
      { result: { content: { api: 3 } } },
      { result: [] }, // *.cls
      { result: [] }, // *.mac
    ]);
    await collect(searchStream(BASE_CONN, { query: 'x', categories: ['CLS', 'MAC'], maxResults: 10, includeSystem: false }));
    // calls[0] = version check, calls[1] = *.cls, calls[2] = *.mac
    assert.ok(calls[1].capture.path.includes(encodeURIComponent('*.cls')));
    assert.ok(calls[2].capture.path.includes(encodeURIComponent('*.mac')));
  });

  test('v3: yields results for each mask that has matches', async () => {
    installMultiTransport([
      { result: { content: { api: 3 } } },
      { result: [{ doc: 'Foo.cls', matches: [{ text: 'x' }] }] }, // *.cls
      { result: [{ doc: 'Bar.mac', matches: [{ text: 'x' }] }] }, // *.mac
    ]);
    const { batches } = await collect(searchStream(BASE_CONN, { query: 'x', categories: ['CLS', 'MAC'], maxResults: 10, includeSystem: false }));
    assert.strictEqual(batches.length, 2);
    assert.strictEqual(batches[0][0].name, 'Foo.cls');
    assert.strictEqual(batches[1][0].name, 'Bar.mac');
  });

  test('v3: skips masks that return no results (no empty batch yielded)', async () => {
    installMultiTransport([
      { result: { content: { api: 3 } } },
      { result: [] },                                               // *.cls — empty
      { result: [{ doc: 'My.mac', matches: [{ text: 'x' }] }] },  // *.mac — hit
    ]);
    const { batches } = await collect(searchStream(BASE_CONN, { query: 'x', categories: ['CLS', 'MAC'], maxResults: 10, includeSystem: false }));
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0][0].name, 'My.mac');
  });

  test('v3: continues to next mask when one mask throws', async () => {
    let idx = 0;
    _setTransport(async () => {
      idx++;
      if (idx === 1) return { result: { content: { api: 3 } } };
      if (idx === 2) throw new Error('timeout on *.cls');
      return { result: [{ doc: 'Good.mac', matches: [{ text: 'x' }] }] };
    });
    const { batches } = await collect(searchStream(BASE_CONN, { query: 'x', categories: ['CLS', 'MAC'], maxResults: 10, includeSystem: false }));
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0][0].name, 'Good.mac');
  });

  // ── apiVersion check fallback ─────────────────────────────────────────────

  test('falls back to per-mask when version check throws', async () => {
    let idx = 0;
    _setTransport(async () => {
      idx++;
      if (idx === 1) throw new Error('no /api/atelier/ endpoint'); // version check fails → api = 1
      return { result: [{ doc: 'Foo.cls', matches: [{ text: 'x' }] }] };
    });
    const { all } = await collect(searchStream(BASE_CONN, { query: 'x', categories: ['CLS'], maxResults: 10, includeSystem: false }));
    assert.strictEqual(all[0].name, 'Foo.cls');
  });
});
