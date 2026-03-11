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
  const { query, categories, maxResults, includeSystem, regex = false } = options;

  const masks = buildFileMasks(categories);
  if (masks.length === 0) return [];

  const sysParam = includeSystem ? '1' : '0';
  const regexParam = regex ? '1' : '0';
  const path = buildPath(
    connection,
    `/action/search?query=${encodeURIComponent(query)}&files=${encodeURIComponent(masks.join(','))}&regex=${regexParam}&sys=${sysParam}&max=${maxResults}`,
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

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

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
  const ns = encodeURIComponent(connection.namespace);
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

export interface AtelierQueryResponse {
  result?: unknown;
}

interface SearchDoc {
  doc: string;
  matches: import('./types').ISearchMatch[];
}
