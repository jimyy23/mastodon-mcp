import type { Credential } from "../auth/credentials.ts";
import type { Scope, Site } from "../auth/oauth.ts";

export interface McpContext {
  site: Site;
  scope: Scope;
  cred: Credential;
  /** Endpoint groups exposed as individual tools (from `?expose=`), or empty. */
  expose: string[];
}

/** Thrown from tool handlers to turn the whole HTTP response into a 401/403 auth challenge. */
export class HttpAuthChallenge extends Error {
  constructor(
    public status: 401 | 403,
    public error: "invalid_token" | "insufficient_scope",
    public description: string,
    public scopes?: string[],
  ) {
    super(description);
  }
}
