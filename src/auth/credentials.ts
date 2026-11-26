import type { Config } from "../config.ts";
import { isSealed, safeEqual, unseal } from "./crypto.ts";

/**
 * How the current MCP request is authenticated against Mastodon.
 *
 *  oauth        Authorization: Bearer mmcp.a.*   (token minted by our OAuth facade)
 *  passthrough  Authorization: Bearer <raw Mastodon token>, or X-Mastodon-Token
 *  apikey       Authorization: Bearer <MCP_API_KEYS entry> -> MASTODON_TOKEN(S) for the instance
 *  anonymous    no credential (public endpoints only; app token used where docs require one)
 *
 * Mixed: an API key (or OAuth token) can gate access to this server while
 * `X-Mastodon-Token` supplies the user's own Mastodon token for upstream calls.
 */
export type CredentialKind = "oauth" | "passthrough" | "apikey" | "anonymous";

export interface Credential {
  kind: CredentialKind;
  /** Mastodon access token to use upstream (absent for anonymous / apikey without server token). */
  token?: string;
  /** Scopes granted (known only for oauth). */
  scopes?: string[];
  /** Mastodon app that issued an oauth token (for revocation). */
  app?: [string, string];
  /** True when the token came from the client (a 401 upstream should be surfaced as HTTP 401). */
  clientSupplied: boolean;
}

export interface AccessTokenPayload extends Record<string, unknown> {
  /** instance domain (audience) */
  i: string;
  /** Mastodon access token */
  t: string;
  /** granted scope string */
  s: string;
  /** our client_id */
  c: string;
  /** Mastodon app [client_id, client_secret] */
  ap?: [string, string];
}

export class AuthRequired extends Error {
  constructor(public reason: string, public error: "invalid_token" | "invalid_request" | "" = "") {
    super(reason);
  }
}

function bearer(header: string | null | undefined): string | undefined {
  const m = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return m?.[1];
}

export async function resolveCredential(cfg: Config, instance: string, headers: Headers): Promise<Credential> {
  const auth = bearer(headers.get("authorization"));
  const xToken = headers.get("x-mastodon-token")?.trim() || undefined;
  let gate: Credential | undefined;

  if (auth && isSealed(auth, "a")) {
    if (!cfg.secretKey) throw new AuthRequired("OAuth is not configured on this server", "invalid_token");
    const p = await unseal<AccessTokenPayload>(cfg.secretKey, "a", auth);
    if (!p) throw new AuthRequired("access token invalid or expired", "invalid_token");
    // Audience binding: a token minted for one instance must not be used on another.
    if (p.i !== instance) throw new AuthRequired(`token was issued for ${p.i}, not ${instance}`, "invalid_token");
    gate = { kind: "oauth", token: p.t, scopes: p.s.split(/\s+/).filter(Boolean), app: p.ap, clientSupplied: true };
  } else if (auth && cfg.apiKeys.some((k) => safeEqual(k, auth))) {
    const t = cfg.serverTokens[instance];
    gate = { kind: "apikey", token: t, clientSupplied: false };
  } else if (auth) {
    if (!cfg.allowPassthrough) throw new AuthRequired("unrecognized bearer token", "invalid_token");
    gate = { kind: "passthrough", token: auth, clientSupplied: true };
  }

  if (xToken) {
    if (!cfg.allowPassthrough) throw new AuthRequired("X-Mastodon-Token is disabled on this server", "invalid_request");
    return { kind: "passthrough", token: xToken, clientSupplied: true };
  }

  if (gate) return gate;
  if (cfg.authMode === "required") throw new AuthRequired("authentication required");
  return { kind: "anonymous", clientSupplied: false };
}
