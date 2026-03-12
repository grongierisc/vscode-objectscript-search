/**
 * Type definitions for the InterSystems Atelier REST API.
 *
 * Mirrors the structure of vscode-objectscript's `src/api/atelier.ts`,
 * containing only the subset used by this extension.
 */

// ---------------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------------

/** Standard Atelier REST API response envelope. */
export interface Response<T = unknown> {
  status?: {
    summary: string;
    errors: { code: number; error: string; params?: string[] }[];
  };
  result: T;
  console?: string[];
  /** Truthy when the server still has pending work (GET /work/{id}). */
  retryafter?: string;
}

/** Wraps a single value in a `content` property (server-info, etc.). */
export interface Content<T> {
  content: T;
}

// ---------------------------------------------------------------------------
// Server info
// ---------------------------------------------------------------------------

/** Payload of the `GET /api/atelier/` response. */
export interface ServerInfo {
  version: string;
  id: string;
  api: number;
  namespaces: string[];
  features?: { name: string; enabled: boolean }[];
  links?: { name: string; application: string }[];
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** One document entry returned by a search operation. */
export interface SearchResult {
  doc: string;
  matches: SearchMatch[];
}

/** One matched line within a document, as returned by the Atelier search API. */
export interface SearchMatch {
  /** The matched source line text. */
  text: string;
  /** Class member name, present when the match is inside a class member. */
  member?: string;
  /**
   * Attribute of the member or class where the match was found.
   * Common values: `"Description"`, `"Code"`, `"Data"`, `"SqlQuery"`,
   * `"IncludeCode"`, `"IncludeGenerator"`, `"Import"`, `"Copyright"`,
   * `"Super"`, `"Name"`, or a comma-separated Storage XML tag chain
   * (e.g. `"Default,DataLocation"`).
   */
  attr?: string;
  /** 1-based line offset within the member body (code / implementation matches). */
  line?: number;
  /** 1-based line offset within a multi-line attribute value (Description, Code, Storage, etc.). */
  attrline?: number;
}

// ---------------------------------------------------------------------------
// Async /work queue
// ---------------------------------------------------------------------------

/** Base type for requests sent to `POST /{ns}/work`. */
export interface AsyncRequest {
  request: string;
  console?: boolean;
  [key: string]: unknown;
}

/** Body for queuing an asynchronous search via `POST /{ns}/work`. */
export interface AsyncSearchRequest extends AsyncRequest {
  request: 'search';
  query: string;
  regex?: boolean;
  case?: boolean;
  word?: boolean;
  wild?: boolean;
  documents?: string;
  system?: boolean;
  generated?: boolean;
  max?: number;
  project?: string;
  /** Regex (string) of file-name patterns to include. */
  include?: string;
  /** Regex (string) of file-name patterns to exclude. */
  exclude?: string;
  /** Include namespace-mapped documents in results. Ignored when `project` is set. */
  mapped?: boolean;
}
