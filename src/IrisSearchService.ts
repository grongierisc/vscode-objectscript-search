import * as https from 'https';
import * as http from 'http';
import * as vscode from 'vscode';
import type { IConnection, ISearchOptions, ISearchResult } from './types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search IRIS documents via the Atelier v2 /action/search endpoint.
 * Results are grouped by document, each with their list of in-document matches.
 */
export async function search(
  connection: IConnection,
  options: ISearchOptions,
): Promise<ISearchResult[]> {
  const { query, categories, maxResults, includeSystem, includeGenerated = false, regex = false } = options;

  const masks = buildFileMasks(categories);
  if (masks.length === 0) return [];

  const sysParam = includeSystem ? '1' : '0';
  const genParam = includeGenerated ? '1' : '0';
  const regexParam = regex ? '1' : '0';
  const path = buildPath(
    connection,
    `/action/search?query=${encodeURIComponent(query)}&files=${encodeURIComponent(masks.join(','))}&regex=${regexParam}&sys=${sysParam}&gen=${genParam}&max=${maxResults}`,
    2,
  );

  try {
    const data = await makeRequest(connection, 'GET', path);
    const docs = (data?.result ?? []) as SearchDoc[];
    return docs.map((doc) => ({
      name: doc.doc,
      category: categoryFromDocName(doc.doc),
      matches: doc.matches,
    }));
  } catch (err) {
    console.error('[ObjectScript Search] Search failed:', err);
    return [];
  }
}

/**
 * Streaming search: automatically uses the Atelier v6+ asynchronous `/work`
 * queue endpoint when the server supports it, and falls back to sending one
 * synchronous request per file-type mask on older servers.
 *
 * Results are yielded as batches so the UI can be updated progressively.
 */
export async function* searchStream(
  connection: IConnection,
  options: ISearchOptions,
): AsyncGenerator<ISearchResult[]> {
  const apiVersion = await getApiVersion(connection);
  if (apiVersion >= 6) {
    yield* searchStreamAsync(connection, options);
  } else {
    yield* searchStreamPerMask(connection, options);
  }
}

/**
 * Atelier API v6+: queue a single search job via `POST /{ns}/work`, then poll
 * `GET /{ns}/work/{id}` until the server stops returning a `Retry-After`
 * header, yielding each batch of results as it arrives.
 *
 * The server processes the search asynchronously and streams partial results
 * back through repeated polls — classes and routines are returned as soon as
 * each doc-type is finished rather than waiting for the full search.
 */
async function* searchStreamAsync(
  connection: IConnection,
  options: ISearchOptions,
): AsyncGenerator<ISearchResult[]> {
  const { query, categories, maxResults, includeSystem, includeGenerated = false, regex = false } = options;

  const masks = buildFileMasks(categories);
  if (masks.length === 0) return;

  // Queue the search job on the server
  const workPath = buildPath(connection, '/work', 1);
  const body = JSON.stringify({
    request: 'search',
    console: false,
    query,
    regex,
    case: false,
    word: false,
    wild: false,
    documents: masks.join(','),
    system: includeSystem,
    generated: includeGenerated,
    max: maxResults,
  });

  let queueResp: AtelierQueryResponse;
  try {
    queueResp = await makeRequest(connection, 'POST', workPath, body);
  } catch (err) {
    // The /work endpoint is absent or doesn't support async search on this server.
    // Fall back transparently to the per-mask synchronous path.
    yield* searchStreamPerMask(connection, options);
    return;
  }

  // The Location header contains the relative URL of the job, e.g. "USER/work/abc123"
  const rawLocation = queueResp.location ?? '';
  const jobId = rawLocation.split('/').filter(Boolean).pop();
  if (!jobId) {
    // Job ID missing — server accepted the request but gave no handle; fall back.
    yield* searchStreamPerMask(connection, options);
    return;
  }

  // Poll until done, yielding each batch of results
  const pollPath = buildPath(connection, `/work/${jobId}`, 1);
  for (;;) {
    const pollResp = await makeRequest(connection, 'GET', pollPath);
    const docs = (pollResp.result ?? []) as SearchDoc[];
    const results = docs.map((doc) => ({
      name: doc.doc,
      category: categoryFromDocName(doc.doc),
      matches: doc.matches,
    }));
    if (results.length > 0) {
      yield results;
    }
    if (!pollResp.retryafter) break;
    // The Retry-After header signals the job is still running; wait briefly
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Atelier API v1–v5 fallback: one synchronous GET request per file-type mask.
 * Results arrive as each mask completes — classes typically before routines.
 */
async function* searchStreamPerMask(
  connection: IConnection,
  options: ISearchOptions,
): AsyncGenerator<ISearchResult[]> {
  const { query, categories, maxResults, includeSystem, includeGenerated = false, regex = false } = options;

  const masks = buildFileMasks(categories);
  if (masks.length === 0) return;

  const sysParam = includeSystem ? '1' : '0';
  const genParam = includeGenerated ? '1' : '0';
  const regexParam = regex ? '1' : '0';

  for (const mask of masks) {
    const path = buildPath(
      connection,
      `/action/search?query=${encodeURIComponent(query)}&files=${encodeURIComponent(mask)}&regex=${regexParam}&sys=${sysParam}&gen=${genParam}&max=${maxResults}`,
      2,
    );
    try {
      const data = await makeRequest(connection, 'GET', path);
      const docs = (data?.result ?? []) as SearchDoc[];
      const results = docs.map((doc) => ({
        name: doc.doc,
        category: categoryFromDocName(doc.doc),
        matches: doc.matches,
      }));
      if (results.length > 0) {
        yield results;
      }
    } catch (err) {
      console.error(`[ObjectScript Search] Search failed for mask ${mask}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Query the server's Atelier REST API version number.
 * Returns 1 (safe minimum) if the check fails for any reason.
 */
async function getApiVersion(connection: IConnection): Promise<number> {
  try {
    const prefix = connection.pathPrefix?.replace(/\/$/, '') ?? '';
    const data = await makeRequest(connection, 'GET', `${prefix}/api/atelier/`);
    const content = (data?.result as { content?: { api?: number } })?.content;
    return typeof content?.api === 'number' ? content.api : 1;
  } catch {
    return 1;
  }
}

/** Build Atelier file masks from category filter. */
function buildFileMasks(categories: import('./types').DocCategory[]): string[] {
  if (categories.length === 0) return ['*.cls', '*.mac', '*.int', '*.inc'];
  const masks = new Set<string>();
  for (const cat of categories) {
    if (cat === 'CLS' || cat === 'PKG') masks.add('*.cls');
    if (cat === 'RTN' || cat === 'MAC') masks.add('*.mac');
    if (cat === 'RTN' || cat === 'INT') masks.add('*.int');
    if (cat === 'INC') masks.add('*.inc');
    if (cat === 'CSP') masks.add('*.csp');
  }
  return [...masks];
}

/** Derive our category code from a document name's extension. */
function categoryFromDocName(docName: string): string {
  const ext = docName.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'cls': return 'CLS';
    case 'mac': return 'MAC';
    case 'int': return 'INT';
    case 'inc': return 'INC';
    case 'csp': return 'CSP';
    default:    return 'OTH';
  }
}

export function buildPath(connection: IConnection, suffix: string, version = 1): string {
  const prefix = connection.pathPrefix?.replace(/\/$/, '') ?? '';
  const ns = encodeURIComponent(connection.ns);
  return `${prefix}/api/atelier/v${version}/${ns}${suffix}`;
}

// ---------------------------------------------------------------------------
// Injectable transport — replaced in unit tests via _setTransport()
// ---------------------------------------------------------------------------

export interface RequestCapture {
  method: string;
  path: string;
  hostname: string;
  port: number;
  headers: Record<string, string>;
  body?: string;
}

export type TransportFn = (
  capture: RequestCapture,
) => Promise<AtelierQueryResponse>;

let _transport: TransportFn | undefined;

/** @internal Inject a fake transport for unit tests. Pass undefined to reset. */
export function _setTransport(fn: TransportFn | undefined): void {
  _transport = fn;
}

function makeRequest(
  connection: IConnection,
  method: string,
  path: string,
  body?: string,
): Promise<AtelierQueryResponse> {
  const allowSelfSigned = vscode.workspace
    .getConfiguration('objectscriptSearch')
    .get<boolean>('allowSelfSignedCertificates', false);

  const auth = Buffer.from(`${connection.username}:${connection.password}`).toString('base64');
  const headers: Record<string, string> = {
    Authorization: `Basic ${auth}`,
    Accept: 'application/json',
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body).toString();
  }

  const capture: RequestCapture = {
    method,
    path,
    hostname: connection.host,
    port: connection.port,
    headers,
    body,
  };

  if (_transport) {
    return _transport(capture).then((resp) => {
      if (resp.status?.summary) {
        throw new Error(resp.status.summary);
      }
      return resp;
    });
  }

  return new Promise((resolve, reject) => {
    const options: http.RequestOptions & https.RequestOptions = {
      hostname: connection.host,
      port: connection.port,
      path,
      method,
      headers,
      rejectUnauthorized: !allowSelfSigned,
    };

    const protocol = connection.scheme === 'https' ? https : http;
    const req = protocol.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) {
          try {
            const parsed: AtelierQueryResponse = raw ? JSON.parse(raw) : {};
            // Capture async-work headers so callers can handle job IDs and polling.
            if (res.headers.location) { parsed.location = res.headers.location as string; }
            if (res.headers['retry-after']) { parsed.retryafter = res.headers['retry-after'] as string; }
            // Surface application-level errors embedded in a 2xx response body.
            if (parsed.status?.summary) {
              reject(new Error(parsed.status.summary));
              return;
            }
            resolve(parsed);
          } catch {
            reject(new Error(`Failed to parse IRIS response: ${raw.substring(0, 200)}`));
          }
        } else {
          reject(new Error(`IRIS server returned HTTP ${res.statusCode}: ${raw.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Response shape types (internal)
// ---------------------------------------------------------------------------

export interface AtelierQueryResponse {
  result?: unknown;
  /** Application-level status returned by the server (present even on HTTP 2xx). */
  status?: { summary?: string; errors?: unknown[] };
  /** Value of the `Retry-After` response header (GET /work/{id}): truthy = job still running. */
  retryafter?: string;
  /** Value of the `Location` response header (POST /work): relative URL of the queued job. */
  location?: string;
}

interface SearchDoc {
  doc: string;
  matches: import('./types').ISearchMatch[];
}
