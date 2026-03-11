export type DocCategory = 'CLS' | 'RTN' | 'MAC' | 'INT' | 'INC' | 'PKG' | 'CSP';

export type SearchType = 'name' | 'content';

export interface IConnection {
  serverName?: string;
  host: string;
  port: number;
  scheme: string;
  pathPrefix: string;
  namespace: string;
  username: string;
  password: string;
}

export interface ISearchOptions {
  query: string;
  searchType: SearchType;
  categories: DocCategory[];
  maxResults: number;
  includeSystem: boolean;
}

export interface ISearchResult {
  /** Full document name, e.g. "My.Package.ClassName.cls" or "MyRoutine.mac" */
  name: string;
  /** Atelier category string, e.g. "CLS", "MAC", "INT", "INC" */
  category: string;
  /** Optional snippet showing where the match was found (content search) */
  context?: string;
}
