/**
 * Runtime configuration, read from environment variables (Worker `env` bindings or
 * `process.env` in Node). Every option is documented in README.md and .env.example;
 * keep the three in sync.
 */
export interface Config {
  /** Instance used by `/mcp` (no domain in path). */
  defaultInstance?: string;
  /** If non-empty, only these instance domains may be proxied. */
  allowedInstances: string[];
  /** Hosts reached over plain http (local dev only), e.g. `localhost:3000`. */
  httpInstances: string[];
  /** Allow IP literals / localhost / private names as instances (dev only). */
  allowPrivateInstances: boolean;

  /** `required`: every MCP request needs a credential (401 triggers OAuth). `optional`: anonymous allowed. */
  authMode: "required" | "optional";
  /** Accept raw Mastodon access tokens in `Authorization: Bearer`. */
  allowPassthrough: boolean;
  /** Secret used to seal OAuth codes/tokens. OAuth facade is disabled without it. */
  secretKey?: string;
  /** Scopes requested from Mastodon when the MCP client doesn't ask for specific ones. */
  defaultScopes: string;
  /** Scopes the Mastodon app is registered with (superset of anything we may request). */
  appScopes: string;
  /** Lifetime of access tokens minted by the OAuth facade (refresh tokens don't expire). */
  tokenTtlSeconds: number;
  /** For OAuth tokens lacking a scope, answer HTTP 403 insufficient_scope (MCP step-up) instead of a tool error. */
  scopeStepUp: boolean;
  /** Static API keys that map to server-side Mastodon tokens (`serverTokens`). */
  apiKeys: string[];
  /** Server-side Mastodon tokens per instance domain, used with an API key. */
  serverTokens: Record<string, string>;
  /** Pre-registered Mastodon OAuth apps per instance: { domain: { client_id, client_secret } }. */
  presetApps: Record<string, { client_id: string; client_secret: string }>;

  /** Allowed browser Origins for /mcp. `*` allows any. Same-origin is always allowed. */
  allowedOrigins: string[];
  /** Public base URL of this server (e.g. https://mcp.example.com). Inferred from the request if unset. */
  publicUrl?: string;
  /** Honor X-Forwarded-Proto/Host when inferring the public URL (behind a reverse proxy). */
  trustProxy: boolean;

  /** Block non-GET Mastodon calls. */
  readOnly: boolean;
  /** Hide and block admin endpoints. */
  disableAdmin: boolean;
  /** Max characters of tool output before truncation. */
  maxOutputChars: number;
  /** Upstream request timeout (ms). */
  upstreamTimeoutMs: number;
  /** Max bytes accepted when fetching media by URL. */
  maxUploadBytes: number;
  userAgent: string;
}

type EnvLike = Record<string, unknown>;

const str = (env: EnvLike, k: string): string | undefined => {
  const v = env[k];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};
const list = (env: EnvLike, k: string): string[] =>
  (str(env, k) ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
const bool = (env: EnvLike, k: string, dflt: boolean): boolean => {
  const v = str(env, k)?.toLowerCase();
  if (v === undefined) return dflt;
  return ["1", "true", "yes", "on"].includes(v);
};
const int = (env: EnvLike, k: string, dflt: number): number => {
  const n = Number(str(env, k));
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
function json<T>(env: EnvLike, k: string, dflt: T): T {
  const v = str(env, k);
  if (!v) return dflt;
  try {
    return JSON.parse(v) as T;
  } catch {
    throw new Error(`${k} must be valid JSON`);
  }
}

export function loadConfig(env: EnvLike): Config {
  const defaultInstance = str(env, "DEFAULT_INSTANCE")?.toLowerCase();
  const serverTokens: Record<string, string> = {};
  for (const [d, t] of Object.entries(json<Record<string, string>>(env, "MASTODON_TOKENS", {}))) serverTokens[d.toLowerCase()] = t;
  const single = str(env, "MASTODON_TOKEN");
  if (single && defaultInstance && !serverTokens[defaultInstance]) serverTokens[defaultInstance] = single;
  const presetApps: Config["presetApps"] = {};
  for (const [d, a] of Object.entries(json<Config["presetApps"]>(env, "MASTODON_APPS", {}))) presetApps[d.toLowerCase()] = a;

  return {
    defaultInstance,
    allowedInstances: list(env, "ALLOWED_INSTANCES"),
    httpInstances: list(env, "HTTP_INSTANCES"),
    allowPrivateInstances: bool(env, "ALLOW_PRIVATE_INSTANCES", false),
    authMode: str(env, "AUTH_MODE")?.toLowerCase() === "optional" ? "optional" : "required",
    allowPassthrough: bool(env, "ALLOW_PASSTHROUGH", true),
    secretKey: str(env, "SECRET_KEY"),
    defaultScopes: str(env, "DEFAULT_SCOPES") ?? "read write follow push profile",
    appScopes: str(env, "APP_SCOPES") ?? "read write follow push profile admin:read admin:write",
    tokenTtlSeconds: int(env, "TOKEN_TTL_SECONDS", 30 * 86400),
    scopeStepUp: bool(env, "SCOPE_STEP_UP", false),
    apiKeys: (str(env, "MCP_API_KEYS") ?? "").split(/[\s,]+/).filter(Boolean),
    serverTokens,
    presetApps,
    allowedOrigins: list(env, "ALLOWED_ORIGINS"),
    publicUrl: str(env, "PUBLIC_URL")?.replace(/\/+$/, ""),
    trustProxy: bool(env, "TRUST_PROXY", false),
    readOnly: bool(env, "READ_ONLY", false),
    disableAdmin: bool(env, "DISABLE_ADMIN", false),
    maxOutputChars: int(env, "MAX_OUTPUT_CHARS", 40000),
    upstreamTimeoutMs: int(env, "UPSTREAM_TIMEOUT_MS", 30000),
    maxUploadBytes: int(env, "MAX_UPLOAD_BYTES", 100 * 1024 * 1024),
    userAgent: str(env, "USER_AGENT") ?? "mastodon-mcp/0.1",
  };
}
