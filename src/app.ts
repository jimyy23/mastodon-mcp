/**
 * HTTP routes (runtime-agnostic Hono app; used by both src/worker.ts and src/node.ts).
 *
 *   POST /mcp                                  MCP endpoint for DEFAULT_INSTANCE
 *   POST /{instance}/mcp                       MCP endpoint for any instance
 *   GET  /.well-known/oauth-protected-resource[/{instance}]/mcp      RFC 9728
 *   GET  /.well-known/oauth-authorization-server[/{instance}]        RFC 8414 (path insertion)
 *   GET  [/{instance}]/.well-known/oauth-authorization-server        (path appending, lenient)
 *   *    [/{instance}]/oauth/{authorize,token,register,revoke}       OAuth facade
 *   POST /oauth/consent, GET /oauth/callback                         shared OAuth steps
 *   GET  /, /health, /llms.txt, /catalog.json, [/{instance}]/llms.txt
 */
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { Config } from "./config.ts";
import { AuthRequired, resolveCredential } from "./auth/credentials.ts";
import * as oauth from "./auth/oauth.ts";
import type { Scope, Site } from "./auth/oauth.ts";
import { CATALOG_META, ENDPOINTS } from "./catalog/index.ts";
import { InstanceError, normalizeInstance } from "./instance.ts";
import { HttpAuthChallenge, type McpContext } from "./mcp/context.ts";
import { ERR, handleRpc, type RpcRequest } from "./mcp/protocol.ts";
import { docsIndex, guide } from "./mcp/resources.ts";
import type { Store } from "./store.ts";
import { SERVER_INFO } from "./version.ts";

export interface AppDeps {
  cfg: Config;
  store: Store;
}

function baseUrl(c: Context, cfg: Config): string {
  if (cfg.publicUrl) return cfg.publicUrl;
  const u = new URL(c.req.url);
  if (cfg.trustProxy) {
    const proto = c.req.header("x-forwarded-proto")?.split(",")[0].trim();
    const host = c.req.header("x-forwarded-host")?.split(",")[0].trim();
    if (proto) u.protocol = `${proto}:`;
    if (host) u.host = host;
  }
  return `${u.protocol}//${u.host}`;
}

export function createApp({ cfg, store }: AppDeps) {
  const app = new Hono();
  const site = (c: Context): Site => ({ cfg, store, base: baseUrl(c, cfg) });

  /** Resolve the instance scope for a route; `raw` undefined means the default instance. */
  function scopeFor(raw: string | undefined): Scope {
    if (raw === undefined) {
      if (!cfg.defaultInstance) throw new InstanceError("no DEFAULT_INSTANCE configured; use /{instance_domain}/mcp", 404);
      return { instance: normalizeInstance(cfg.defaultInstance, { ...cfg, allowedInstances: [] }), prefix: "" };
    }
    const instance = normalizeInstance(raw, cfg);
    return { instance, prefix: `/${instance}` };
  }

  app.onError((err, c) => {
    if (err instanceof InstanceError) return c.json({ error: err.message }, err.status as 400);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  // Public metadata & OAuth endpoints are CORS-open (browser-based MCP clients need them).
  const openCors = cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type", "MCP-Protocol-Version"], maxAge: 86400 });
  app.use("/.well-known/*", openCors);
  app.use("/*/.well-known/*", openCors);
  app.use("/oauth/token", openCors);
  app.use("/oauth/register", openCors);
  app.use("/oauth/revoke", openCors);
  app.use("/:instance/oauth/token", openCors);
  app.use("/:instance/oauth/register", openCors);
  app.use("/:instance/oauth/revoke", openCors);

  // ---------- info ----------

  app.get("/", (c) => {
    const s = site(c);
    return c.json({
      name: SERVER_INFO.name,
      version: SERVER_INFO.version,
      mcp: cfg.defaultInstance ? `${s.base}/mcp` : undefined,
      mcp_template: `${s.base}/{instance_domain}/mcp`,
      oauth: !!cfg.secretKey,
      docs: `${s.base}/llms.txt`,
      catalog: `${s.base}/catalog.json`,
      endpoints: CATALOG_META.count,
    });
  });
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/catalog.json", (c) => {
    c.header("Cache-Control", "public, max-age=3600");
    return c.json({ ...CATALOG_META, endpoints: cfg.disableAdmin ? ENDPOINTS.filter((e) => !e.group.startsWith("admin")) : ENDPOINTS });
  });
  const llms = (c: Context, s: Scope | undefined) => {
    const st = site(c);
    const ctx = { site: st, scope: s ?? { instance: "{instance_domain}", prefix: "/{instance_domain}" }, cred: { kind: "anonymous", clientSupplied: false }, expose: [] } as McpContext;
    c.header("Content-Type", "text/markdown; charset=utf-8");
    return c.body(`${guide(ctx)}\n${docsIndex()}\n`);
  };
  app.get("/llms.txt", (c) => llms(c, cfg.defaultInstance ? scopeFor(undefined) : undefined));
  app.get("/:instance/llms.txt", (c) => llms(c, scopeFor(c.req.param("instance"))));

  // ---------- discovery ----------

  const prm = (c: Context, raw?: string) => c.json(oauth.protectedResourceMetadata(site(c), scopeFor(raw)));
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => prm(c));
  app.get("/.well-known/oauth-protected-resource", (c) => prm(c));
  app.get("/.well-known/oauth-protected-resource/:instance/mcp", (c) => prm(c, c.req.param("instance")));

  const asm = (c: Context, raw?: string) => {
    if (!cfg.secretKey) return c.json({ error: "OAuth is disabled on this server (no SECRET_KEY)" }, 404);
    return c.json(oauth.authorizationServerMetadata(site(c), scopeFor(raw)));
  };
  for (const wk of ["oauth-authorization-server", "openid-configuration"]) {
    app.get(`/.well-known/${wk}`, (c) => asm(c));
    app.get(`/.well-known/${wk}/:instance`, (c) => asm(c, c.req.param("instance")));
    app.get(`/:instance/.well-known/${wk}`, (c) => asm(c, c.req.param("instance")));
  }

  // ---------- OAuth facade ----------

  app.post("/oauth/consent", (c) => oauth.consent(c, site(c)));
  app.get("/oauth/callback", (c) => oauth.callback(c, site(c)));
  const oauthRoutes = (prefix: string, getScope: (c: Context) => Scope) => {
    app.get(`${prefix}/oauth/authorize`, (c) => oauth.authorize(c, site(c), getScope(c)));
    app.post(`${prefix}/oauth/token`, (c) => oauth.token(c, site(c), getScope(c)));
    app.post(`${prefix}/oauth/register`, (c) => oauth.register(c, site(c)));
    app.post(`${prefix}/oauth/revoke`, (c) => oauth.revoke(c, site(c)));
  };
  oauthRoutes("", () => scopeFor(undefined));
  oauthRoutes("/:instance", (c) => scopeFor(c.req.param("instance")));

  // ---------- MCP ----------

  const mcp = async (c: Context, raw?: string) => {
    const st = site(c);
    const origin = c.req.header("origin");
    if (origin && origin !== st.base && !cfg.allowedOrigins.includes("*") && !cfg.allowedOrigins.includes(origin.toLowerCase())) {
      return c.json({ jsonrpc: "2.0", error: { code: ERR.INVALID_REQUEST, message: `Origin ${origin} not allowed` } }, 403);
    }
    const s = scopeFor(raw);
    const challenge = (status: 401 | 403, error: string, description: string, scopes?: string[]) => {
      const parts = [`resource_metadata="${oauth.resourceMetadataUrl(st, s)}"`];
      if (error) parts.push(`error="${error}"`);
      parts.push(`error_description="${description.replace(/"/g, "'")}"`);
      const sc = scopes ?? (status === 401 ? cfg.defaultScopes.split(/\s+/) : undefined);
      if (sc?.length) parts.push(`scope="${sc.join(" ")}"`);
      c.header("WWW-Authenticate", `Bearer ${parts.join(", ")}`);
      return c.json({ jsonrpc: "2.0", error: { code: ERR.INVALID_REQUEST, message: description } }, status);
    };

    let cred;
    try {
      cred = await resolveCredential(cfg, s.instance, c.req.raw.headers);
    } catch (e) {
      if (e instanceof AuthRequired) return challenge(401, e.error, e.reason);
      throw e;
    }

    const len = Number(c.req.header("content-length") ?? 0);
    if (len > cfg.maxUploadBytes * 1.4 + 65536) return c.json({ jsonrpc: "2.0", error: { code: ERR.INVALID_REQUEST, message: "request too large" } }, 413);
    let msg: unknown;
    try {
      msg = await c.req.json();
    } catch {
      return c.json({ jsonrpc: "2.0", error: { code: ERR.PARSE, message: "Parse error" } }, 400);
    }
    const expose = (c.req.query("expose") ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    const ctx: McpContext = { site: st, scope: s, cred, expose };
    const headers = c.req.raw.headers;

    try {
      if (Array.isArray(msg)) {
        // JSON-RPC batch (2025-03-26 only). Responses for requests only.
        const outs = await Promise.all(msg.map((m) => handleRpc(ctx, m as RpcRequest, headers)));
        const bodies = outs.map((o) => o.body).filter(Boolean);
        return bodies.length ? c.json(bodies) : c.body(null, 202);
      }
      const out = await handleRpc(ctx, msg as RpcRequest, headers);
      if (out.body === undefined) return c.body(null, out.status as 202);
      return c.json(out.body, out.status as 200);
    } catch (e) {
      if (e instanceof HttpAuthChallenge) return challenge(e.status, e.error, e.description, e.scopes);
      throw e;
    }
  };

  const notAllowed = (c: Context) => {
    c.header("Allow", "POST");
    return c.json({ jsonrpc: "2.0", error: { code: ERR.INVALID_REQUEST, message: "Method not allowed: use POST" } }, 405);
  };
  const mcpCors = cors({
    origin: (o) => (cfg.allowedOrigins.includes("*") || cfg.allowedOrigins.includes(o.toLowerCase()) ? o : null),
    allowHeaders: ["Authorization", "Content-Type", "Accept", "MCP-Protocol-Version", "Mcp-Method", "Mcp-Name", "X-Mastodon-Token", "Last-Event-ID", "Mcp-Session-Id"],
    exposeHeaders: ["WWW-Authenticate"],
    allowMethods: ["POST", "OPTIONS"],
    maxAge: 86400,
  });
  app.use("/mcp", mcpCors);
  app.use("/:instance/mcp", mcpCors);
  app.post("/mcp", (c) => mcp(c));
  app.post("/:instance/mcp", (c) => mcp(c, c.req.param("instance")));
  app.on(["GET", "DELETE", "PUT", "PATCH"], ["/mcp", "/:instance/mcp"], notAllowed);

  app.notFound((c) => c.json({ error: "not found", hint: "MCP endpoint is POST /{instance_domain}/mcp" }, 404));
  return app;
}
