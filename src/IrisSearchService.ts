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
  const docs = (data?.result?.content ?? []) as AtelierDoc[];

  return docs
    .filter((doc) => isCategoryMatch(doc.cat, categories))
    .slice(0, maxResults)
    .map((doc) => ({ name: doc.name, category: doc.cat }));
}

/** Search class/routine content via Atelier SQL query endpoint. */
export async function searchByContent(
  connection: IConnection,
  options: ISearchOptions,
): Promise<ISearchResult[]> {
  const { query, categories, maxResults, includeSystem } = options;
  const results: ISearchResult[] = [];

  const wantClasses =
    categories.length === 0 || categories.some((c) => c === 'CLS' || c === 'PKG');
  const wantRoutines =
    categories.length === 0 || categories.some((c) => ['RTN', 'MAC', 'INT'].includes(c));
  const wantIncludes = categories.length === 0 || categories.includes('INC');

  if (wantClasses && results.length < maxResults) {
    const clsResults = await searchClassContent(
      connection,
      query,
      maxResults - results.length,
      includeSystem,
    );
    results.push(...clsResults);
  }

  if ((wantRoutines || wantIncludes) && results.length < maxResults) {
    const rtnResults = await searchRoutineContent(
      connection,
      query,
      maxResults - results.length,
      wantIncludes,
      includeSystem,
    );
    results.push(...rtnResults);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function searchClassContent(
  connection: IConnection,
  query: string,
  limit: number,
  includeSystem: boolean,
): Promise<ISearchResult[]> {
  const systemFilter = includeSystem ? '' : `AND m.parent NOT %STARTSWITH '%'`;
  // Use parameterized SQL to prevent injection
  const sql = `
    SELECT TOP ? m.parent As ClassName, m.Name As MemberName, m.Implementation As Content
    FROM %Dictionary.MethodDefinition m
    WHERE m.Implementation [ ?
    ${systemFilter}
  `;

  try {
    const data = await runQuery(connection, sql, [limit, query]);
    return ((data?.result?.content ?? []) as ClassContentRow[]).map((row) => ({
      name: `${row.ClassName}.cls`,
      category: 'CLS',
      context: `${row.MemberName}: ${extractSnippet(row.Content ?? '', query)}`,
    }));
  } catch (err) {
    console.error('[ObjectScript Search] Class content search failed:', err);
    return [];
  }
}

async function searchRoutineContent(
  connection: IConnection,
  query: string,
  limit: number,
  includeIncludes: boolean,
  includeSystem: boolean,
): Promise<ISearchResult[]> {
  const typeList = includeIncludes ? "'MAC','INT','INC'" : "'MAC','INT'";
  const systemFilter = includeSystem ? '' : `AND r.name NOT %STARTSWITH '%'`;
  // %Library.RoutineIndex stores name without extension; type is separate column
  const sql = `
    SELECT TOP ? r.name, r.type
    FROM %Library.RoutineIndex r
    WHERE r.name [ ?
    AND r.type IN (${typeList})
    ${systemFilter}
  `;

  try {
    const data = await runQuery(connection, sql, [limit, query]);
    return ((data?.result?.content ?? []) as RoutineRow[]).map((row) => ({
      name: `${row.name}.${(row.type ?? 'mac').toLowerCase()}`,
      category: (row.type ?? 'MAC').toUpperCase(),
    }));
  } catch (err) {
    console.error('[ObjectScript Search] Routine content search failed:', err);
    return [];
  }
}

export function buildPath(connection: IConnection, suffix: string): string {
  const prefix = connection.pathPrefix?.replace(/\/$/, '') ?? '';
  const ns = encodeURIComponent(connection.namespace);
  return `${prefix}/api/atelier/v1/${ns}${suffix}`;
}

async function runQuery(
  connection: IConnection,
  query: string,
  parameters: unknown[],
): Promise<AtelierQueryResponse> {
  const path = buildPath(connection, '/action/query');
  const body = JSON.stringify({ query, parameters });
  return makeRequest(connection, 'POST', path, body);
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

function makeRequest(
  connection: IConnection,
  method: string,
  path: string,
  body?: string,
): Promise<AtelierQueryResponse> {
  return new Promise((resolve, reject) => {
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

interface AtelierQueryResponse {
  result?: {
    content?: unknown[];
  };
}

interface ClassContentRow {
  ClassName: string;
  MemberName: string;
  Content?: string;
}

interface RoutineRow {
  name: string;
  type?: string;
}
