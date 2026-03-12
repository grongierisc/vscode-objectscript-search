import * as https from 'https';
import * as http from 'http';
import * as vscode from 'vscode';
import type { IConnection, ISearchOptions, DocCategory } from '../types';
import * as Atelier from './atelier';

export { Atelier };

// ---------------------------------------------------------------------------
// Injectable transport — replaced in unit tests via _setTransport()
// ---------------------------------------------------------------------------

/** Snapshot of every field that the real HTTP layer would use, captured for tests. */
export interface RequestCapture {
  method: string;
  path: string;
  hostname: string;
  port: number;
  headers: Record<string, string>;
  body?: string;
}

export type TransportFn = (capture: RequestCapture) => Promise<Atelier.Response>;

let _transport: TransportFn | undefined;

/** @internal Inject a fake transport for unit tests. Pass `undefined` to reset. */
export function _setTransport(fn: TransportFn | undefined): void {
  _transport = fn;
}

// ---------------------------------------------------------------------------
// AtelierAPI
// ---------------------------------------------------------------------------

/**
 * Thin HTTP client for the InterSystems Atelier REST API.
 *
 * Modelled after `AtelierAPI` in vscode-objectscript's `src/api/index.ts`:
 * each server operation is a named method (`actionSearch`, `queueAsync`,
 * `pollAsync`, …) that delegates to the single `request()` method, keeping
 * all authentication and path-building logic in one place.
 */
export class AtelierAPI {
  readonly connection: IConnection;

  /** Upper-cased namespace, e.g. `"USER"`. */
  get ns(): string {
    return this.connection.ns.toUpperCase();
  }

  get active(): boolean {
    return !!this.connection.host && !!this.connection.port;
  }

  constructor(connection: IConnection) {
    this.connection = connection;
  }

  // ---------------------------------------------------------------------------
  // API methods — mirroring vscode-objectscript's AtelierAPI
  // ---------------------------------------------------------------------------

  /** api v0 — `GET /api/atelier/` (no version prefix, no namespace). */
  serverInfo(): Promise<Atelier.Response<Atelier.Content<Atelier.ServerInfo>>> {
    return this.request(0, 'GET') as Promise<
      Atelier.Response<Atelier.Content<Atelier.ServerInfo>>
    >;
  }

  // api v2+
  actionSearch(params: {
    query: string;
    files?: string;
    sys?: boolean;
    gen?: boolean;
    max?: number;
    regex?: boolean;
    case?: boolean;
    word?: boolean;
    wild?: boolean;
  }): Promise<Atelier.Response<Atelier.SearchResult[]>> {
    const merged = {
      files: '*.cls,*.mac,*.int,*.inc',
      gen: false,
      sys: false,
      regex: false,
      case: false,
      wild: false,
      word: false,
      ...params,
    };
    return this.request(
      2,
      'GET',
      `${encodeURIComponent(this.ns)}/action/search`,
      undefined,
      merged as Record<string, unknown>,
    ) as Promise<Atelier.Response<Atelier.SearchResult[]>>;
  }

  // api v1+
  queueAsync(request: Atelier.AsyncRequest): Promise<Atelier.Response> {
    return this.request(1, 'POST', `${encodeURIComponent(this.ns)}/work`, request);
  }

  // api v1+
  pollAsync(id: string): Promise<Atelier.Response> {
    return this.request(1, 'GET', `${encodeURIComponent(this.ns)}/work/${id}`);
  }

  // api v1+
  cancelAsync(id: string): Promise<Atelier.Response> {
    return this.request(1, 'DELETE', `${encodeURIComponent(this.ns)}/work/${id}`);
  }

  // ---------------------------------------------------------------------------
  // Core request method
  // ---------------------------------------------------------------------------

  /**
   * Send an HTTP request to the Atelier REST API.
   *
   * Mirrors the signature of `AtelierAPI.request()` from vscode-objectscript:
   *   - `minVersion = 0` → no version prefix (`GET /api/atelier/`)
   *   - `minVersion > 0` → `/api/atelier/v{minVersion}/{path}`
   *
   * Boolean params are serialized as `"1"`/`"0"` (Atelier convention).
   * Application-level errors in 2xx responses (`status.summary !== ""`) are
   * thrown as `{ errorText, statusCode }` objects, matching vscode-objectscript.
   */
  async request(
    minVersion: number,
    method: string,
    path?: string,
    body?: unknown,
    params?: Record<string, unknown>,
  ): Promise<Atelier.Response> {
    const prefix = (this.connection.pathPrefix ?? '').replace(/\/$/, '');
    const urlPath =
      minVersion > 0
        ? `${prefix}/api/atelier/v${minVersion}/${path ?? ''}`
        : `${prefix}/api/atelier/`;
    const fullPath = urlPath + this._buildParams(params);
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;

    const allowSelfSigned = vscode.workspace
      .getConfiguration('objectscriptSearch')
      .get<boolean>('allowSelfSignedCertificates', false);

    const auth = Buffer.from(
      `${this.connection.username}:${this.connection.password}`,
    ).toString('base64');
    const headers: Record<string, string> = {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
    };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr).toString();
    }

    const capture: RequestCapture = {
      method: method.toUpperCase(),
      path: fullPath,
      hostname: this.connection.host,
      port: this.connection.port,
      headers,
      body: bodyStr,
    };

    if (_transport) {
      return _transport(capture).then((resp) => {
        if (resp.status?.summary) {
          throw { errorText: resp.status.summary, statusCode: 200 };
        }
        return resp;
      });
    }

    return new Promise((resolve, reject) => {
      const opts: http.RequestOptions & https.RequestOptions = {
        hostname: this.connection.host,
        port: this.connection.port,
        path: fullPath,
        method: method.toUpperCase(),
        headers,
        rejectUnauthorized: !allowSelfSigned,
      };

      const protocol = this.connection.scheme === 'https' ? https : http;
      const req = protocol.request(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const statusCode = res.statusCode ?? 0;
          if (statusCode >= 200 && statusCode < 300) {
            let parsed: Atelier.Response;
            try {
              parsed = raw ? JSON.parse(raw) : { status: { summary: '', errors: [] }, result: {} };
            } catch {
              reject({
                errorText: `Failed to parse IRIS response: ${raw.substring(0, 200)}`,
                statusCode,
              });
              return;
            }
            // Surface application-level errors from 2xx responses (matches vscode-objectscript).
            if (parsed.status?.summary) {
              reject({ errorText: parsed.status.summary, statusCode });
              return;
            }
            // Store /work headers in the result object (matches vscode-objectscript).
            if (res.headers.location) {
              (parsed.result as Record<string, unknown>).location = res.headers.location;
            }
            if (res.headers['retry-after']) {
              parsed.retryafter = res.headers['retry-after'] as string;
            }
            resolve(parsed);
          } else {
            reject({
              errorText: `IRIS server returned HTTP ${statusCode}: ${raw.substring(0, 200)}`,
              statusCode,
            });
          }
        });
      });

      req.on('error', reject);
      if (bodyStr) {
        req.write(bodyStr);
      }
      req.end();
    });
  }

  /** Serialize query params — boolean values become `"1"`/`"0"` (Atelier convention). */
  private _buildParams(params?: Record<string, unknown>): string {
    if (!params) return '';
    const parts: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'boolean') {
        parts.push(`${key}=${value ? '1' : '0'}`);
      } else if (value !== undefined && value !== null && value !== '') {
        parts.push(`${key}=${encodeURIComponent(String(value))}`);
      }
    }
    return parts.length ? '?' + parts.join('&') : '';
  }
}

// ---------------------------------------------------------------------------
// Search stream
// ---------------------------------------------------------------------------

/**
 * Streaming search: uses the Atelier v6+ asynchronous `/work` queue endpoint
 * when the server supports it, falling back to one synchronous
 * `GET /action/search` per file-type mask on older servers.
 *
 * The same pattern is used by vscode-objectscript's `TextSearchProvider`
 * (`provideTextSearchResults`): `api.queueAsync(request)` → poll
 * `api.pollAsync(id)` until `retryafter` is absent.
 *
 * Results are yielded as `Atelier.SearchResult[]` batches so the caller can
 * update the UI progressively.
 */
export async function* searchStream(
  api: AtelierAPI,
  options: ISearchOptions,
): AsyncGenerator<Atelier.SearchResult[]> {
  const apiVersion = await api
    .serverInfo()
    .then((r) => r.result.content.api)
    .catch(() => 1);

  if (apiVersion >= 6) {
    yield* _searchStreamAsync(api, options);
  } else {
    yield* _searchStreamPerMask(api, options);
  }
}

/**
 * Atelier API v6+: queue a single job via `queueAsync`, then poll with
 * `pollAsync` until the server stops returning a `Retry-After` header.
 * Falls back transparently to `_searchStreamPerMask` when async search is
 * unsupported (e.g. server reports HTTP 404 or an application-level error).
 */
async function* _searchStreamAsync(
  api: AtelierAPI,
  options: ISearchOptions,
): AsyncGenerator<Atelier.SearchResult[]> {
  const { query, categories, maxResults, includeSystem, includeGenerated = false, regex = false } =
    options;

  const masks = buildFileMasks(categories);
  if (masks.length === 0) return;

  const request: Atelier.AsyncSearchRequest = {
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
  };

  let id: string;
  try {
    const queueResp = await api.queueAsync(request);
    // The server stores the job handle in result.location (vscode-objectscript convention).
    id = (queueResp.result as { location?: string })?.location ?? '';
  } catch {
    // /work endpoint absent or returned an error — fall back to per-mask.
    yield* _searchStreamPerMask(api, options);
    return;
  }

  if (!id) {
    // No job ID returned — fall back to per-mask.
    yield* _searchStreamPerMask(api, options);
    return;
  }

  // Poll until the job is complete, yielding each non-empty batch.
  for (;;) {
    const pollResp = await api.pollAsync(id);
    const docs = (pollResp.result ?? []) as Atelier.SearchResult[];
    if (docs.length > 0) {
      yield docs;
    }
    if (!pollResp.retryafter) break;
    // Retry-After header present → job still running; brief pause before next poll.
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Atelier API v1–v5 fallback: one synchronous GET `/action/search` per
 * file-type mask.  Partial results arrive as each mask completes (classes
 * typically before routines).
 */
async function* _searchStreamPerMask(
  api: AtelierAPI,
  options: ISearchOptions,
): AsyncGenerator<Atelier.SearchResult[]> {
  const { query, categories, maxResults, includeSystem, includeGenerated = false, regex = false } =
    options;

  const masks = buildFileMasks(categories);

  for (const mask of masks) {
    try {
      const resp = await api.actionSearch({
        query,
        files: mask,
        sys: includeSystem,
        gen: includeGenerated,
        max: maxResults,
        regex,
      });
      const docs = (resp.result ?? []) as Atelier.SearchResult[];
      if (docs.length > 0) {
        yield docs;
      }
    } catch (err) {
      console.error(`[ObjectScript Search] Search failed for mask ${mask}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Build Atelier file masks from the user-selected category filter. */
export function buildFileMasks(categories: DocCategory[]): string[] {
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
export function categoryFromDocName(docName: string): string {
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
