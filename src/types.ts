export type DocCategory = 'CLS' | 'RTN' | 'MAC' | 'INT' | 'INC' | 'PKG' | 'CSP';

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
  categories: DocCategory[];
  maxResults: number;
  includeSystem: boolean;
  includeGenerated?: boolean;
  regex?: boolean;
}

export interface ISearchMatch {
  text: string;
  member?: string;
  line?: string;
}

export interface ISearchResult {
  /** Full document name, e.g. "My.Package.ClassName.cls" or "MyRoutine.mac" */
  name: string;
  /** Atelier category code, e.g. "CLS", "MAC", "INT", "INC" */
  category: string;
  /** All matches found within this document */
  matches: ISearchMatch[];
}
