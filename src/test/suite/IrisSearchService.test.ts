import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  AtelierAPI,
  searchStream,
  buildFileMasks,
  categoryFromDocName,
  _setTransport,
  Atelier,
} from '../../api';
import type { RequestCapture } from '../../api';
import type { IConnection } from '../../types';

const BASE_CONN: IConnection = {
  host: 'localhost',
  port: 52773,
  scheme: 'http',
  pathPrefix: '',
  ns: 'USER',
  username: '_SYSTEM',
  password: 'SYS',
};

interface CapturedCall {
  capture: RequestCapture;
  response: Atelier.Response;
}

function installTransport(response: Atelier.Response, calls: CapturedCall[] = []): CapturedCall[] {
  _setTransport(async (capture) => { calls.push({ capture, response }); return response; });
  return calls;
}

function installMultiTransport(responses: Array<Partial<Atelier.Response> & Record<string, unknown>>): CapturedCall[] {
  const calls: CapturedCall[] = [];
  let idx = 0;
  _setTransport(async (capture) => {
    const response = (responses[idx] ?? responses[responses.length - 1]) as Atelier.Response;
    idx++;
    calls.push({ capture, response });
    return response;
  });
  return calls;
}

function makeSandbox() {
  const sandbox = sinon.createSandbox();
  sandbox.stub(vscode.workspace, 'getConfiguration').returns({
    get: (_key: string, def?: unknown) => def,
    has: () => false,
    inspect: () => undefined,
    update: async () => undefined,
  } as unknown as vscode.WorkspaceConfiguration);
  return sandbox;
}

// ---------------------------------------------------------------------------
// Suite: AtelierAPI — URL construction
// ---------------------------------------------------------------------------

suite('AtelierAPI > request paths', () => {
  let sandbox: sinon.SinonSandbox;
  setup(() => { sandbox = makeSandbox(); });
  teardown(() => { sandbox.restore(); _setTransport(undefined); });

  test('actionSearch builds v2 path without prefix', async () => {
    const calls = installTransport({ result: [] });
    await new AtelierAPI({ ...BASE_CONN, pathPrefix: '' }).actionSearch({ query: 'x' }).catch(() => undefined);
    assert.ok(calls[0].capture.path.startsWith('/api/atelier/v2/USER/action/search'), `path: ${calls[0].capture.path}`);
  });

  test('actionSearch builds v2 path with prefix (no trailing slash)', async () => {
    const calls = installTransport({ result: [] });
    await new AtelierAPI({ ...BASE_CONN, pathPrefix: '/myapp' }).actionSearch({ query: 'x' }).catch(() => undefined);
    assert.ok(calls[0].capture.path.startsWith('/myapp/api/atelier/v2/USER/action/search'), `path: ${calls[0].capture.path}`);
  });

  test('actionSearch strips trailing slash from prefix', async () => {
    const calls = installTransport({ result: [] });
    await new AtelierAPI({ ...BASE_CONN, pathPrefix: '/myapp/' }).actionSearch({ query: 'x' }).catch(() => undefined);
    assert.ok(calls[0].capture.path.startsWith('/myapp/api/atelier/v2/USER/action/search'), `path: ${calls[0].capture.path}`);
  });

  test('actionSearch URL-encodes namespace', async () => {
    const calls = installTransport({ result: [] });
    await new AtelierAPI({ ...BASE_CONN, ns: 'MY NS' }).actionSearch({ query: 'x' }).catch(() => undefined);
    assert.ok(calls[0].capture.path.includes('/MY%20NS/'), `path: ${calls[0].capture.path}`);
  });

  test('serverInfo uses no version prefix', async () => {
    const calls = installTransport({ result: { content: { api: 1, version: '', id: '', namespaces: [] } } });
    await new AtelierAPI(BASE_CONN).serverInfo().catch(() => undefined);
    assert.ok(calls[0].capture.path.endsWith('/api/atelier/'), `path: ${calls[0].capture.path}`);
    assert.ok(!calls[0].capture.path.includes('/api/atelier/v'), `should have no /v: ${calls[0].capture.path}`);
  });

  test('queueAsync POSTs to v1 /ns/work', async () => {
    const calls = installTransport({ result: { location: 'USER/work/job1' } });
    await new AtelierAPI(BASE_CONN).queueAsync({ request: 'search' }).catch(() => undefined);
    assert.strictEqual(calls[0].capture.method, 'POST');
    assert.ok(calls[0].capture.path.endsWith('/USER/work'), `path: ${calls[0].capture.path}`);
  });

  test('pollAsync GETs v1 /ns/work/{id}', async () => {
    const calls = installTransport({ result: [] });
    await new AtelierAPI(BASE_CONN).pollAsync('abc123').catch(() => undefined);
    assert.strictEqual(calls[0].capture.method, 'GET');
    assert.ok(calls[0].capture.path.includes('/USER/work/abc123'), `path: ${calls[0].capture.path}`);
  });
});

// ---------------------------------------------------------------------------
// Suite: AtelierAPI — actionSearch
// ---------------------------------------------------------------------------

suite('AtelierAPI > actionSearch', () => {
  let sandbox: sinon.SinonSandbox;
  setup(() => { sandbox = makeSandbox(); });
  teardown(() => { sandbox.restore(); _setTransport(undefined); });

  test('makes a single GET request', async () => {
    const calls = installTransport({ result: [] });
    await new AtelierAPI(BASE_CONN).actionSearch({ query: 'findme' });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].capture.method, 'GET');
  });

  test('sends query as URL parameter on v2 path', async () => {
    const calls = installTransport({ result: [] });
    await new AtelierAPI(BASE_CONN).actionSearch({ query: 'findme' });
    assert.ok(calls[0].capture.path.includes('/api/atelier/v2/'));
    assert.ok(calls[0].capture.path.includes('query=' + encodeURIComponent('findme')));
  });

  test('passes sys=0 for false', async () => {
    const calls = installTransport({ result: [] });
    await new AtelierAPI(BASE_CONN).actionSearch({ query: 'q', sys: false });
    assert.ok(calls[0].capture.path.includes('sys=0'));
  });

  test('passes sys=1 for true', async () => {
    const calls = installTransport({ result: [] });
    await new AtelierAPI(BASE_CONN).actionSearch({ query: 'q', sys: true });
    assert.ok(calls[0].capture.path.includes('sys=1'));
  });

  test('passes gen=0 by default', async () => {
    const calls = installTransport({ result: [] });
    await new AtelierAPI(BASE_CONN).actionSearch({ query: 'q' });
    assert.ok(calls[0].capture.path.includes('gen=0'));
  });

  test('passes gen=1 when true', async () => {
    const calls = installTransport({ result: [] });
    await new AtelierAPI(BASE_CONN).actionSearch({ query: 'q', gen: true });
    assert.ok(calls[0].capture.path.includes('gen=1'));
  });

  test('includes Basic auth header', async () => {
    const calls = installTransport({ result: [] });
    await new AtelierAPI(BASE_CONN).actionSearch({ query: 'x' });
    const expected = 'Basic ' + Buffer.from('_SYSTEM:SYS').toString('base64');
    assert.strictEqual(calls[0].capture.headers['Authorization'], expected);
  });

  test('returns SearchResult array from result', async () => {
    installTransport({
      result: [{ doc: 'My.Package.ClassName.cls', matches: [{ member: 'MyMethod', text: 'findme here' }] }],
    });
    const resp = await new AtelierAPI(BASE_CONN).actionSearch({ query: 'findme' });
    const docs = resp.result as Atelier.SearchResult[];
    assert.strictEqual(docs.length, 1);
    assert.strictEqual(docs[0].doc, 'My.Package.ClassName.cls');
    assert.strictEqual(docs[0].matches[0].member, 'MyMethod');
  });

  test('throws on application-level error (status.summary)', async () => {
    _setTransport(async () => ({ status: { summary: 'Some server error', errors: [] }, result: {} }));
    await assert.rejects(new AtelierAPI(BASE_CONN).actionSearch({ query: 'x' }));
  });
});

// ---------------------------------------------------------------------------
// Suite: helpers
// ---------------------------------------------------------------------------

suite('AtelierAPI > helpers', () => {
  test('buildFileMasks: empty -> all defaults', () => {
    assert.deepStrictEqual(buildFileMasks([]), ['*.cls', '*.mac', '*.int', '*.inc']);
  });

  test('buildFileMasks: CLS -> *.cls only', () => {
    assert.deepStrictEqual(buildFileMasks(['CLS']), ['*.cls']);
  });

  test('buildFileMasks: RTN -> *.mac and *.int', () => {
    const m = buildFileMasks(['RTN']);
    assert.ok(m.includes('*.mac') && m.includes('*.int') && !m.includes('*.cls'));
  });

  test('buildFileMasks: MAC -> *.mac only', () => {
    assert.deepStrictEqual(buildFileMasks(['MAC']), ['*.mac']);
  });

  test('buildFileMasks: INC -> *.inc only', () => {
    assert.deepStrictEqual(buildFileMasks(['INC']), ['*.inc']);
  });

  test('buildFileMasks: CSP -> *.csp only', () => {
    assert.deepStrictEqual(buildFileMasks(['CSP']), ['*.csp']);
  });

  test('buildFileMasks: deduplicates (CLS + PKG -> one *.cls)', () => {
    assert.strictEqual(buildFileMasks(['CLS', 'PKG']).filter(m => m === '*.cls').length, 1);
  });

  test('categoryFromDocName: .cls -> CLS', () => { assert.strictEqual(categoryFromDocName('My.Cls.cls'), 'CLS'); });
  test('categoryFromDocName: .mac -> MAC', () => { assert.strictEqual(categoryFromDocName('Rtn.mac'), 'MAC'); });
  test('categoryFromDocName: .int -> INT', () => { assert.strictEqual(categoryFromDocName('Rtn.int'), 'INT'); });
  test('categoryFromDocName: .inc -> INC', () => { assert.strictEqual(categoryFromDocName('My.inc'), 'INC'); });
  test('categoryFromDocName: .csp -> CSP', () => { assert.strictEqual(categoryFromDocName('/csp/user/page.csp'), 'CSP'); });
  test('categoryFromDocName: unknown -> OTH', () => { assert.strictEqual(categoryFromDocName('File.obj'), 'OTH'); });
});

// ---------------------------------------------------------------------------
// Suite: searchStream
// ---------------------------------------------------------------------------

suite('AtelierAPI > searchStream', () => {
  let sandbox: sinon.SinonSandbox;
  setup(() => { sandbox = makeSandbox(); });
  teardown(() => { sandbox.restore(); _setTransport(undefined); });

  async function collect(gen: AsyncIterable<Atelier.SearchResult[]>) {
    const batches: Atelier.SearchResult[][] = [];
    for await (const b of gen) batches.push(b);
    return { batches, all: batches.flat() };
  }

  // -- v6 async path ---------------------------------------------------------

  test('v6: POSTs to /work endpoint when apiVersion >= 6', async () => {
    const calls = installMultiTransport([
      { result: { content: { api: 6 } } },
      { result: { location: 'USER/work/job1' } },
      { result: [] },
    ]);
    await collect(searchStream(new AtelierAPI(BASE_CONN), { query: 'x', categories: ['CLS'], maxResults: 10, includeSystem: false }));
    assert.strictEqual(calls[1].capture.method, 'POST');
    assert.ok(calls[1].capture.path.endsWith('/work'), `path: ${calls[1].capture.path}`);
  });

  test('v6: POST body contains required search parameters', async () => {
    const calls = installMultiTransport([
      { result: { content: { api: 6 } } },
      { result: { location: 'USER/work/job1' } },
      { result: [] },
    ]);
    await collect(searchStream(new AtelierAPI(BASE_CONN), { query: 'findme', categories: ['CLS'], maxResults: 50, includeSystem: true, includeGenerated: true }));
    const body = JSON.parse(calls[1].capture.body as string);
    assert.strictEqual(body.request, 'search');
    assert.strictEqual(body.query, 'findme');
    assert.ok(body.documents.includes('*.cls'), 'documents should include *.cls');
    assert.strictEqual(body.max, 50);
    assert.strictEqual(body.system, true);
    assert.strictEqual(body.generated, true);
  });

  test('v6: yields SearchResult batches from poll response', async () => {
    installMultiTransport([
      { result: { content: { api: 6 } } },
      { result: { location: 'USER/work/job1' } },
      { result: [{ doc: 'Foo.cls', matches: [{ member: 'Bar', text: 'findme' }] }] },
    ]);
    const { all } = await collect(searchStream(new AtelierAPI(BASE_CONN), { query: 'findme', categories: ['CLS'], maxResults: 10, includeSystem: false }));
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].doc, 'Foo.cls');
    assert.strictEqual(all[0].matches[0].member, 'Bar');
  });

  test('v6: polls again when Retry-After header is present', async () => {
    const calls = installMultiTransport([
      { result: { content: { api: 6 } } },
      { result: { location: 'USER/work/job1' } },
      { result: [], retryafter: '0.05' },
      { result: [{ doc: 'Done.cls', matches: [{ text: 'x' }] }] },
    ]);
    await collect(searchStream(new AtelierAPI(BASE_CONN), { query: 'x', categories: ['CLS'], maxResults: 10, includeSystem: false }));
    assert.strictEqual(calls.filter(c => c.capture.method === 'GET' && c.capture.path.includes('/work/')).length, 2);
  });

  test('v6: yields one batch per non-empty poll', async () => {
    installMultiTransport([
      { result: { content: { api: 6 } } },
      { result: { location: 'USER/work/job1' } },
      { result: [{ doc: 'A.cls', matches: [{ text: 'hit' }] }], retryafter: '0.05' },
      { result: [{ doc: 'B.mac', matches: [{ text: 'hit' }] }] },
    ]);
    const { batches, all } = await collect(searchStream(new AtelierAPI(BASE_CONN), { query: 'hit', categories: ['CLS'], maxResults: 10, includeSystem: false }));
    assert.strictEqual(batches.length, 2);
    assert.strictEqual(all[0].doc, 'A.cls');
    assert.strictEqual(all[1].doc, 'B.mac');
  });

  test('v6: skips empty intermediate polls silently', async () => {
    installMultiTransport([
      { result: { content: { api: 6 } } },
      { result: { location: 'USER/work/job1' } },
      { result: [], retryafter: '0.05' },
      { result: [{ doc: 'C.cls', matches: [{ text: 'ok' }] }] },
    ]);
    const { batches } = await collect(searchStream(new AtelierAPI(BASE_CONN), { query: 'ok', categories: ['CLS'], maxResults: 10, includeSystem: false }));
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0][0].doc, 'C.cls');
  });

  test('v6: falls back to per-mask when /work POST fails (HTTP 404)', async () => {
    let idx = 0;
    _setTransport(async () => {
      idx++;
      if (idx === 1) return { result: { content: { api: 6 } } };
      if (idx === 2) throw new Error('IRIS server returned HTTP 404');
      return { result: [{ doc: 'Fallback.cls', matches: [{ text: 'x' }] }] };
    });
    const { all } = await collect(searchStream(new AtelierAPI(BASE_CONN), { query: 'x', categories: ['CLS'], maxResults: 10, includeSystem: false }));
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].doc, 'Fallback.cls');
  });

  test('v6: falls back to per-mask when /work returns status.summary error', async () => {
    let idx = 0;
    _setTransport(async () => {
      idx++;
      if (idx === 1) return { result: { content: { api: 6 } } };
      if (idx === 2) return { status: { summary: "ERROR #16004: Unknown request type 'search'", errors: [] }, result: {} };
      return { result: [{ doc: 'Fallback.cls', matches: [{ text: 'x' }] }] };
    });
    const { all } = await collect(searchStream(new AtelierAPI(BASE_CONN), { query: 'x', categories: ['CLS'], maxResults: 10, includeSystem: false }));
    assert.strictEqual(all[0].doc, 'Fallback.cls');
  });

  test('v6: falls back to per-mask when /work returns no job ID', async () => {
    installMultiTransport([
      { result: { content: { api: 6 } } },
      { result: {} },
      { result: [{ doc: 'Fallback.cls', matches: [{ text: 'x' }] }] },
    ]);
    const { all } = await collect(searchStream(new AtelierAPI(BASE_CONN), { query: 'x', categories: ['CLS'], maxResults: 10, includeSystem: false }));
    assert.strictEqual(all[0].doc, 'Fallback.cls');
  });

  // -- v1-v5 per-mask path ---------------------------------------------------

  test('v3: falls back to per-mask GET /action/search', async () => {
    const calls = installMultiTransport([
      { result: { content: { api: 3 } } },
      { result: [{ doc: 'Foo.cls', matches: [{ text: 'x' }] }] },
    ]);
    await collect(searchStream(new AtelierAPI(BASE_CONN), { query: 'x', categories: ['CLS'], maxResults: 10, includeSystem: false }));
    assert.strictEqual(calls[1].capture.method, 'GET');
    assert.ok(calls[1].capture.path.includes('/action/search'), `path: ${calls[1].capture.path}`);
  });

  test('v3: sends one request per mask', async () => {
    const calls = installMultiTransport([
      { result: { content: { api: 3 } } },
      { result: [] },
      { result: [] },
    ]);
    await collect(searchStream(new AtelierAPI(BASE_CONN), { query: 'x', categories: ['CLS', 'MAC'], maxResults: 10, includeSystem: false }));
    assert.ok(calls[1].capture.path.includes(encodeURIComponent('*.cls')));
    assert.ok(calls[2].capture.path.includes(encodeURIComponent('*.mac')));
  });

  test('v3: yields SearchResult batches for each mask with matches', async () => {
    installMultiTransport([
      { result: { content: { api: 3 } } },
      { result: [{ doc: 'Foo.cls', matches: [{ text: 'x' }] }] },
      { result: [{ doc: 'Bar.mac', matches: [{ text: 'x' }] }] },
    ]);
    const { batches } = await collect(searchStream(new AtelierAPI(BASE_CONN), { query: 'x', categories: ['CLS', 'MAC'], maxResults: 10, includeSystem: false }));
    assert.strictEqual(batches.length, 2);
    assert.strictEqual(batches[0][0].doc, 'Foo.cls');
    assert.strictEqual(batches[1][0].doc, 'Bar.mac');
  });

  test('v3: skips masks that return no results', async () => {
    installMultiTransport([
      { result: { content: { api: 3 } } },
      { result: [] },
      { result: [{ doc: 'My.mac', matches: [{ text: 'x' }] }] },
    ]);
    const { batches } = await collect(searchStream(new AtelierAPI(BASE_CONN), { query: 'x', categories: ['CLS', 'MAC'], maxResults: 10, includeSystem: false }));
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0][0].doc, 'My.mac');
  });

  test('v3: continues to next mask when one mask throws', async () => {
    let idx = 0;
    _setTransport(async () => {
      idx++;
      if (idx === 1) return { result: { content: { api: 3 } } };
      if (idx === 2) throw new Error('timeout on *.cls');
      return { result: [{ doc: 'Good.mac', matches: [{ text: 'x' }] }] };
    });
    const { batches } = await collect(searchStream(new AtelierAPI(BASE_CONN), { query: 'x', categories: ['CLS', 'MAC'], maxResults: 10, includeSystem: false }));
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0][0].doc, 'Good.mac');
  });

  // -- version check fallback ------------------------------------------------

  test('falls back to per-mask when serverInfo throws', async () => {
    let idx = 0;
    _setTransport(async () => {
      idx++;
      if (idx === 1) throw new Error('no /api/atelier/ endpoint');
      return { result: [{ doc: 'Foo.cls', matches: [{ text: 'x' }] }] };
    });
    const { all } = await collect(searchStream(new AtelierAPI(BASE_CONN), { query: 'x', categories: ['CLS'], maxResults: 10, includeSystem: false }));
    assert.strictEqual(all[0].doc, 'Foo.cls');
  });
});
