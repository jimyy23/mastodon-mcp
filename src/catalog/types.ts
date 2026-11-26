/** Where a parameter is sent. `body` is JSON or multipart form data. */
export type ParamLocation = "path" | "query" | "body" | "header";

/**
 * Auth required by an endpoint, derived from the docs' **OAuth:** line.
 * - public: no token needed
 * - optional: works anonymously, more data/features with a user token
 * - user: user token required
 * - app: app (client_credentials) token required
 */
export type AuthKind = "public" | "optional" | "user" | "app";

/**
 * rest: normal JSON request/response
 * stream: server-sent events (collected for a bounded time)
 * websocket: not callable over MCP
 * browser: a URL to open in a browser (OAuth authorize)
 */
export type EndpointKind = "rest" | "stream" | "websocket" | "browser";

export interface Param {
  /** Name as written in the docs, e.g. `poll[options][]`, `media_ids[]`, `id`. */
  name: string;
  in: ParamLocation;
  /** Normalized: string | int | number | bool | datetime | object | file | string[] | int[] | object[] | string|string[] */
  type: string;
  required?: boolean;
  file?: boolean;
  enum?: string[];
  desc?: string;
}

export interface Endpoint {
  /** Stable id: `<docs file path with dots>.<anchor>`, e.g. `statuses.create`, `admin.accounts.approve`. */
  id: string;
  group: string;
  method: string;
  /** Path template with `:param` placeholders. */
  path: string;
  title: string;
  desc?: string;
  auth: AuthKind;
  scopes: string[];
  /** Raw OAuth note from docs when it carries nuance beyond auth+scopes. */
  authNote?: string;
  returns?: string;
  /** Entity doc names referenced by `returns`, e.g. ["Status", "ScheduledStatus"]. */
  entities?: string[];
  params: Param[];
  since?: string;
  apiVersion?: number;
  deprecated?: boolean;
  kind?: EndpointKind;
  /** `<docs path>#<anchor>` relative to content/en/methods. */
  doc: string;
  /** Set for entries from overrides.ts that aren't in the docs. */
  undocumented?: boolean;
}

export interface CatalogFile {
  source: string;
  commit: string;
  generated: string;
  endpoints: Endpoint[];
}
