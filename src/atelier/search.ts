import type { ISearchOptions, DocCategory } from '../types';
import { AtelierAPI } from './api';
import * as Atelier from './types';

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
  const {
    query,
    categories,
    maxResults,
    includeSystem,
    includeGenerated = false,
    regex = false,
    caseSensitive = false,
    wordMatch = false,
  } = options;

  const masks = buildFileMasks(categories);
  if (masks.length === 0) return;

  // Mirror vscode-objectscript TextSearchProvider: in regex mode the Atelier
  // server matches the full line, so wrap the pattern with .*.* and add (?i)
  // for case-insensitive searches.
  const pattern = buildSearchPattern(query, regex, caseSensitive);

  const request: Atelier.AsyncSearchRequest = {
    request: 'search',
    console: false,
    query: pattern,
    regex,
    case: caseSensitive,
    word: wordMatch,
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
  const {
    query,
    categories,
    maxResults,
    includeSystem,
    includeGenerated = false,
    regex = false,
    caseSensitive = false,
    wordMatch = false,
  } = options;

  const pattern = buildSearchPattern(query, regex, caseSensitive);
  const masks = buildFileMasks(categories);

  for (const mask of masks) {
    try {
      const resp = await api.actionSearch({
        query: pattern,
        files: mask,
        sys: includeSystem,
        gen: includeGenerated,
        max: maxResults,
        regex,
        case: caseSensitive,
        word: wordMatch,
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

/**
 * Build the query pattern sent to the Atelier API.
 *
 * This mirrors the pattern transformation in vscode-objectscript's
 * `TextSearchProvider.provideTextSearchResults()`:
 * > Modify the query pattern if we're doing a regex search.
 * > Needed because the server matches the full line against the regex
 * > and ignores the case parameter when in regex mode.
 *
 * - Non-regex: pattern is passed through unchanged.
 * - Regex + case-insensitive: prefixed with `(?i)` and wrapped with `.*….*`.
 * - Regex + case-sensitive: wrapped with `.*….*` only.
 */
export function buildSearchPattern(query: string, regex: boolean, caseSensitive: boolean): string {
  return regex ? `${!caseSensitive ? '(?i)' : ''}.*${query}.*` : query;
}

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
