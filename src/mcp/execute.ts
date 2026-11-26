import { getAppToken } from "../auth/apps.ts";
import { callbackUrl } from "../auth/oauth.ts";
import { satisfies } from "../auth/scopes.ts";
import { docUrls, isAdmin, matchPath, type Endpoint } from "../catalog/index.ts";
import { collectStream, errorHint, FileInputError, mastodonFetch } from "../mastodon/client.ts";
import { compact, select, serialize } from "../mastodon/format.ts";
import { unflatten } from "../mastodon/params.ts";
import { instanceBaseUrl } from "../instance.ts";
import { HttpAuthChallenge, type McpContext } from "./context.ts";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: unknown;
}

export const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

export interface CallOptions {
  /** compact (default) | full */
  format?: "compact" | "full";
  /** Dot-paths to keep, e.g. ["id","account.acct","content"]. */
  select?: string[];
  /** Follow `next` pages up to this many total pages (GET list endpoints). */
  pages?: number;
  /** Streaming: seconds to listen (default 10, max 25) and max events (default 20). */
  seconds?: number;
  max_events?: number;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Build the upstream request for an endpoint from flat or nested args. */
export function buildRequest(ep: Endpoint, rawArgs: Record<string, unknown>) {
  const args = unflatten(rawArgs);
  let path = ep.path;
  const missing: string[] = [];
  for (const m of ep.path.matchAll(/:([a-z_]+)/g)) {
    const v = args[m[1]];
    if (v === undefined || v === null || v === "") missing.push(m[1]);
    else path = path.replace(`:${m[1]}`, encodeURIComponent(String(v)));
    delete args[m[1]];
  }
  if (missing.length) throw new ArgError(`missing path parameter(s): ${missing.join(", ")}`);
  const headers: Record<string, string> = {};
  for (const p of ep.params) {
    if (p.in !== "header") continue;
    const v = args[p.name];
    if (v !== undefined) headers[p.name] = String(v);
    delete args[p.name];
  }
  // Query vs body: docs say; anything unknown goes to query for GET/DELETE, else body.
  const queryNames = new Set(ep.params.filter((p) => p.in === "query").map((p) => p.name.replace(/\[.*$/, "")));
  const bodyNames = new Set(ep.params.filter((p) => p.in === "body").map((p) => p.name.replace(/\[.*$/, "")));
  const query: Record<string, unknown> = {};
  const body: Record<string, unknown> = {};
  const readLike = ep.method === "GET" || ep.method === "DELETE";
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    if (queryNames.has(k)) query[k] = v;
    else if (bodyNames.has(k)) body[k] = v;
    else (readLike ? query : body)[k] = v;
  }
  const fileKeys = new Set(ep.params.filter((p) => p.file).map((p) => p.name));
  const missingReq = ep.params.filter((p) => p.required && p.in !== "path" && !p.name.includes("[") && args[p.name] === undefined).map((p) => p.name);
  return { path, query, body, headers, fileKeys, missingReq };
}

export class ArgError extends Error {}

/** Pre-flight policy checks shared by every call path. Returns an error string or undefined. */
function policy(ctx: McpContext, ep: Endpoint | undefined, method: string): string | undefined {
  const cfg = ctx.site.cfg;
  if (cfg.readOnly && MUTATING.has(method) && !(ep && ep.group === "oauth")) return "This server is READ_ONLY; mutating calls are disabled.";
  if (cfg.disableAdmin && ep && isAdmin(ep)) return "Admin endpoints are disabled on this server.";
  if (ep?.kind === "websocket") return "WebSocket streaming is not available over MCP; use a streaming.* SSE endpoint instead.";
  if (ep?.kind === "browser") return `This endpoint must be opened in a browser. Use mastodon_auth for the OAuth flow.`;
  return undefined;
}

async function tokenFor(ctx: McpContext, ep: Endpoint | undefined): Promise<string | undefined> {
  if (ctx.cred.token) return ctx.cred.token;
  // Endpoints documented as needing an app token (or optional public access that some
  // instances restrict) get our cached client_credentials token when anonymous.
  if (ep && (ep.auth === "app" || /app token/i.test(ep.authNote ?? ""))) {
    return getAppToken(ctx.site.cfg, ctx.site.store, ctx.scope.instance, callbackUrl(ctx.site));
  }
  return undefined;
}

export async function executeEndpoint(ctx: McpContext, ep: Endpoint, args: Record<string, unknown>, opts: CallOptions = {}): Promise<ToolResult> {
  const blocked = policy(ctx, ep, ep.method);
  if (blocked) return text(blocked, true);

  // Auth is NOT pre-checked against the docs: they are sometimes stricter than Mastodon
  // (e.g. accounts.lookup works anonymously). Mastodon decides; errors get hints in run().

  let req;
  try {
    req = buildRequest(ep, args);
  } catch (e) {
    return text(`${(e as Error).message}. See mastodon_api_describe {"id":"${ep.id}"}.`, true);
  }

  const token = await tokenFor(ctx, ep);

  if (ep.kind === "stream") {
    const seconds = Math.min(Math.max(opts.seconds ?? 10, 1), 25);
    const max = Math.min(Math.max(opts.max_events ?? 20, 1), 200);
    const streamBase = await streamingBase(ctx);
    const qs = new URLSearchParams(Object.entries(req.query).map(([k, v]) => [k, String(v)])).toString();
    const r = await collectStream(ctx.site.cfg, `${streamBase}${req.path}${qs ? "?" + qs : ""}`, token, seconds, max);
    if (r.error) {
      const hint = r.status === 401 && !token ? `Requires authentication. ${authHelp(ctx)}` : errorHint(r.status, null, ep.scopes);
      return text(JSON.stringify({ status: r.status, error: r.error, hint }), true);
    }
    const events = r.events.map((e) => {
      let payload = opts.format === "full" ? e.payload : compact(e.payload);
      if (opts.select?.length && typeof payload === "object") payload = select(payload, opts.select);
      return { event: e.event, payload };
    });
    return text(serialize({ status: r.status, listened_s: seconds, count: events.length, events }, "events", ctx.site.cfg.maxOutputChars));
  }

  // Plain (non-SSE) endpoints that live on the streaming server, e.g. /api/v1/streaming/health.
  const url = ep.path.startsWith("/api/v1/streaming") ? `${await streamingBase(ctx)}${req.path}` : undefined;
  return run(ctx, ep, { method: ep.method, ...req, token, url }, opts);
}

/** Raw call: any method + path on the instance (escape hatch for undocumented/new endpoints). */
export async function executeRaw(
  ctx: McpContext,
  method: string,
  path: string,
  args: { query?: Record<string, unknown>; body?: Record<string, unknown>; headers?: Record<string, string>; files?: string[] },
  opts: CallOptions = {},
): Promise<ToolResult> {
  const m = method.toUpperCase();
  if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(m)) return text("method must be GET, POST, PUT, PATCH or DELETE", true);
  if (!path.startsWith("/") || path.includes("://") || path.includes("..") || path.startsWith("//")) return text("path must be an absolute path on the instance, e.g. /api/v1/timelines/home", true);
  const pathOnly = path.split("?")[0];
  if (!/^\/(api|oauth|\.well-known|nodeinfo|health)\b/.test(pathOnly)) return text("only /api, /oauth, /.well-known, /nodeinfo and /health paths are allowed", true);
  const match = matchPath(m, pathOnly);
  const blocked = policy(ctx, match?.ep, m) ?? (ctx.site.cfg.disableAdmin && /^\/api\/v\d+\/admin\//.test(pathOnly) ? "Admin endpoints are disabled on this server." : undefined);
  if (blocked) return text(blocked, true);
  const extraQuery = Object.fromEntries(new URLSearchParams(path.split("?")[1] ?? ""));
  const token = await tokenFor(ctx, match?.ep);
  return run(
    ctx,
    match?.ep,
    {
      method: m,
      path: pathOnly,
      query: { ...extraQuery, ...(args.query ?? {}) },
      body: args.body ? unflatten(args.body) : {},
      headers: args.headers ?? {},
      fileKeys: new Set([...(args.files ?? []), ...(match?.ep.params.filter((p) => p.file).map((p) => p.name) ?? [])]),
      token,
    },
    opts,
  );
}

async function run(
  ctx: McpContext,
  ep: Endpoint | undefined,
  r: { method: string; path: string; query: Record<string, unknown>; body: Record<string, unknown>; headers: Record<string, string>; fileKeys: Set<string>; token?: string; url?: string },
  opts: CallOptions,
): Promise<ToolResult> {
  const cfg = ctx.site.cfg;
  const pages = Math.min(Math.max(opts.pages ?? 1, 1), 10);
  let res;
  let data: unknown;
  let fetched = 0;
  try {
    res = await mastodonFetch(cfg, ctx.scope.instance, { method: r.method, path: r.path, query: r.query, body: r.body, headers: r.headers, token: r.token, url: r.url }, r.fileKeys);
    data = res.data;
    fetched = 1;
    while (fetched < pages && r.method === "GET" && Array.isArray(data) && res.nextUrl) {
      const nextRes = await mastodonFetch(cfg, ctx.scope.instance, { method: "GET", path: r.path, url: res.nextUrl, token: r.token });
      if (!nextRes.ok || !Array.isArray(nextRes.data)) break;
      data = [...(data as unknown[]), ...nextRes.data];
      res = { ...nextRes, data };
      fetched++;
      if (!nextRes.data.length) break;
    }
  } catch (e) {
    if (e instanceof FileInputError) return text(`file input error: ${e.message}`, true);
    const msg = e instanceof Error ? (e.name === "TimeoutError" ? `upstream timeout after ${cfg.upstreamTimeoutMs}ms` : e.message) : String(e);
    return text(`request to ${ctx.scope.instance} failed: ${msg}`, true);
  }

  if (res.status === 401 && ctx.cred.clientSupplied && ctx.cred.token) {
    // The client's Mastodon token is no longer valid: surface as HTTP 401 so the MCP client re-auths.
    throw new HttpAuthChallenge(401, "invalid_token", "Mastodon rejected the access token (revoked or expired)");
  }

  if (!res.ok) {
    const err: Record<string, unknown> = { status: res.status, error: res.data };
    const location = res.headers.get("location");
    if (location) err.location = location;
    const scopeError = res.status === 403 && /scope/i.test(JSON.stringify(res.data ?? ""));
    if (scopeError && ctx.cred.kind === "oauth" && ctx.site.cfg.scopeStepUp && ep?.scopes.length) {
      // MCP step-up: ask the client to re-authorize with the missing scope added.
      const granted = ctx.cred.scopes ?? [];
      const needed = satisfies(granted, ep.scopes) ? [] : [ep.scopes[0]];
      throw new HttpAuthChallenge(403, "insufficient_scope", `${ep.id} needs ${ep.scopes.join(" or ")}`, [...new Set([...granted, ...needed])]);
    }
    const hint = errorHint(res.status, res.data, ep?.scopes ?? []);
    if (hint) err.hint = hint;
    if (res.status === 401 && !ctx.cred.token) err.hint = `Requires authentication. ${authHelp(ctx)}`;
    if (scopeError && ctx.cred.scopes) err.granted = ctx.cred.scopes.join(" ");
    if (res.status === 429) err.reset = res.headers.get("x-ratelimit-reset");
    if (ep) err.doc = docUrls(ep).raw;
    return text(JSON.stringify(err), true);
  }

  let out: unknown = data;
  if (opts.format !== "full") out = compact(out);
  if (opts.select?.length) out = select(out, opts.select);

  const env: Record<string, unknown> = {};
  if (res.status !== 200) env.status = res.status;
  if (r.method === "GET" && Array.isArray(data)) {
    env.count = (data as unknown[]).length;
    if (fetched > 1) env.pages = fetched;
  }
  if (res.next) env.next = res.next;
  if (res.prev && r.method === "GET" && Array.isArray(data)) env.prev = res.prev;
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (remaining !== null && Number(remaining) < 50) env.ratelimit_remaining = Number(remaining);
  if (res.headers.get("mastodon-async-refresh")) env.async_refresh = res.headers.get("mastodon-async-refresh");
  env.data = out ?? null;
  // Skip the envelope entirely when it carries nothing but data.
  const keys = Object.keys(env);
  if (keys.length === 1) return text(serializeBare(out, cfg.maxOutputChars));
  return text(serialize(env, "data", cfg.maxOutputChars));
}

function serializeBare(v: unknown, max: number): string {
  if (v === null || v === undefined) return "ok (empty response)";
  if (typeof v === "string") return v.length > max ? v.slice(0, max) + "…[truncated]" : v;
  if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) return "ok (empty response)";
  return serialize({ data: v }, "data", max).replace(/^\{"data":/, "").replace(/\}$/, "");
}

const streamCache = new Map<string, { url: string; exp: number }>();

async function streamingBase(ctx: McpContext): Promise<string> {
  const inst = ctx.scope.instance;
  const hit = streamCache.get(inst);
  if (hit && hit.exp > Date.now()) return hit.url;
  let url = instanceBaseUrl(inst, ctx.site.cfg);
  try {
    const r = await mastodonFetch(ctx.site.cfg, inst, { method: "GET", path: "/api/v2/instance" });
    const s = (r.data as { configuration?: { urls?: { streaming?: string } } })?.configuration?.urls?.streaming;
    if (s) url = s.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/+$/, "");
  } catch {}
  streamCache.set(inst, { url, exp: Date.now() + 3600_000 });
  return url;
}

export function authHelp(ctx: McpContext): string {
  const base = `${ctx.site.base}${ctx.scope.prefix}/mcp`;
  return ctx.site.cfg.secretKey
    ? `Reconnect to ${base} with OAuth (your MCP client will open a browser), or send "Authorization: Bearer <mastodon token>".`
    : `Send "Authorization: Bearer <mastodon access token>" (create one in Mastodon: Preferences > Development).`;
}
