import type { SearchMatch } from './atelier/types';

export type DocCategory = 'CLS' | 'RTN' | 'MAC' | 'INT' | 'INC' | 'PKG' | 'CSP';

export interface IConnection {
  serverName?: string;
  host: string;
  port: number;
  scheme: string;
  pathPrefix: string;
  /** Upper-cased IRIS namespace, e.g. "USER". Matches the ns convention of vscode-objectscript. */
  ns: string;
  username: string;
  password: string;
  /** Name of the workspace folder from which this connection was resolved. */
  wsFolderName?: string;
}

export interface ISearchOptions {
  query: string;
  categories: DocCategory[];
  maxResults: number;
  includeSystem: boolean;
  includeGenerated?: boolean;
  /** Use regex matching. When true the pattern is wrapped with `.*….*` and prefixed with `(?i)` for case-insensitive mode (Atelier API behaviour). */
  regex?: boolean;
  /** Case-sensitive match. Only meaningful when `regex` is false; ignored in regex mode (use `(?i)` instead). */
  caseSensitive?: boolean;
  /** Whole-word match. Passed as the `word` parameter to the Atelier API. */
  wordMatch?: boolean;
}

/** Alias for Atelier.SearchMatch — the raw match shape returned by the Atelier API. */
export type ISearchMatch = SearchMatch;

/** App-level search result: an Atelier document entry with its list of matches. */
export interface ISearchResult {
  /** Full document name, e.g. "My.Package.ClassName.cls" or "MyRoutine.mac". */
  name: string;
  /** Atelier category code, e.g. "CLS", "MAC", "INT", "INC". */
  category: string;
  /** All matches found within this document. */
  matches: ISearchMatch[];
}
