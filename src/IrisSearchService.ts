import * as https from 'https';
import * as http from 'http';
import * as vscode from 'vscode';
import type { IConnection, ISearchOptions, ISearchResult, DocCategory } from './types';

/** Maps our category codes to the Atelier API "cat" field values */
const ATELIER_CAT_MAP: Record<DocCategory, string[]> = {
  CLS: ['cls'],
  RTN: ['mac', 'int'],
  MAC: ['mac'],
  INT: ['int'],
  INC: ['inc'],
  PKG: ['pkg'],
  CSP: ['csp'],
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Search document names via the Atelier docnames endpoint. */
export async function searchByName(
  connection: IConnection,
  options: ISearchOptions,
): Promise<ISearchResult[]> {
  const { query, categories, maxResults, includeSystem } = options;

  // Atelier filter: wrap with wildcards when no wildcard already present
  const filter = query.includes('*') ? query : `*${query}*`;
  const systemParam = includeSystem ? '1' : '0';
  const path = buildPath(
    connection,
    `/docnames?filter=${encodeURIComponent(filter)}&generated=0&system=${systemParam}`,
  );

  const data = await makeRequest(connection, 'GET', path);
  const docs = ((data?.result as { content?: unknown[] })?.content ?? []) as AtelierDoc[];

  return docs
    .filter((doc) => isCategoryMatch(doc.cat, categories))
    .slice(0, maxResults)
    .map((doc) => ({ name: doc.name, category: doc.cat }));
}

/** Search file content via the Atelier v2 search endpoint. */
export async function searchByContent(
  connection: IConnection,
  options: ISearchOptions,
): Promise<ISearchResult[]> {
  const { query, categories, maxResults, includeSystem } = options;

  const masks = buildFileMasks(categories);
  if (masks.length === 0) return [];

  const sysParam = includeSystem ? '1' : '0';
  const path = buildPath(
    connection,
    `/action/search?query=${encodeURIComponent(query)}&files=${encodeURIComponent(masks.join(','))}&regex=0&sys=${sysParam}&max=${maxResults}`,
    2,
  );

  try {
    const data = await makeRequest(connection, 'POST', path);
    const docs = (data?.result ?? []) as SearchDoc[];
    return docs
      .flatMap((doc) =>
        doc.matches.map((match) => ({
          name: doc.doc,
          category: categoryFromDocName(doc.doc),
          context: match.member
            ? `${match.member}: ${match.text}`
            : `${match.line ?? ''}: ${match.text}`,
        }))
      )
      .slice(0, maxResults);
  } catch (err) {
    console.error('[ObjectScript Search] Content search failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Build Atelier file masks from category filter. */
function buildFileMasks(categories: DocCategory[]): string[] {
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
  const ns = encodeURIComponent(connection.namespace);
  return `${prefix}/api/atelier/v${version}/${ns}${suffix}`;
}

export function extractSnippet(content: string, query: string): string {
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) {
    return '';
  }
  const start = Math.max(0, idx - 30);
  const end = Math.min(content.length, idx + query.length + 30);
  return content.substring(start, end).replace(/[\r\n]+/g, ' ').trim();
}

export function isCategoryMatch(cat: string, categories: DocCategory[]): boolean {
  if (categories.length === 0) {
    return true;
  }
  const catUpper = cat.toUpperCase();
  return categories.some((c) => {
    if (c === catUpper) {
      return true;
    }
    const mapped = ATELIER_CAT_MAP[c] ?? [];
    return mapped.includes(cat.toLowerCase());
  });
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
    return _transport(capture);
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
            resolve(JSON.parse(raw));
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

interface AtelierDoc {
  name: string;
  cat: string;
  ts?: string;
  db?: string;
}

export interface AtelierQueryResponse {
  // v1 endpoints: result = { content: unknown[] }
  // v2 search endpoint: result = SearchDoc[]
  result?: unknown;
}

interface SearchDoc {
  doc: string;
  matches: SearchMatch[];
}

interface SearchMatch {
  member?: string;
  line?: string;
  text: string;
}
