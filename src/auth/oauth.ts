/**
 * OAuth 2.1 facade for MCP clients, proxying to Mastodon's OAuth.
 *
 * MCP clients need RFC 9728 protected-resource metadata, PKCE for public clients, DCR
 * or Client ID Metadata Documents, and the `resource` parameter. Mastodon doesn't offer
 * that combination, so this server is the authorization server MCP clients talk to.
 * It holds one Mastodon app per instance and wraps the resulting Mastodon token in a
 * sealed (encrypted) token bound to that instance. Nothing is stored server-side
 * except caches.
 *
 *   MCP client ──/authorize──> consent page ──> Mastodon /oauth/authorize
 *              <──code──────── /oauth/callback <──code──
 *   MCP client ──/token (PKCE)──> sealed access + refresh tokens
 *
 * Issuer per instance: `{base}/{instance}`; for the default instance (`/mcp`): `{base}`.
 */
import type { Context } from "hono";
import type { Config } from "../config.ts";
import { instanceBaseUrl, normalizeInstance } from "../instance.ts";
import { getJson, putJson, type Store } from "../store.ts";
import { getApp, UpstreamError } from "./apps.ts";
import type { AccessTokenPayload } from "./credentials.ts";
import { randomToken, seal, sha256b64url, unseal, verifyPkce } from "./crypto.ts";
import { allowedByApp, splitScopes } from "./scopes.ts";

export interface Site {
  cfg: Config;
  store: Store;
  /** Public origin of this server, no trailing slash. */
  base: string;
}

export interface Scope {
  instance: string;
  /** "" for the default instance, else `/{instance}`. */
  prefix: string;
}

export const issuerOf = (site: Site, s: Scope) => `${site.base}${s.prefix}`;
export const resourceOf = (site: Site, s: Scope) => `${site.base}${s.prefix}/mcp`;
export const resourceMetadataUrl = (site: Site, s: Scope) => `${site.base}/.well-known/oauth-protected-resource${s.prefix}/mcp`;
export const callbackUrl = (site: Site) => `${site.base}/oauth/callback`;

const CODE_TTL = 300;
const FLOW_TTL = 900;

// ---------- metadata ----------

export function protectedResourceMetadata(site: Site, s: Scope) {
  return {
    resource: resourceOf(site, s),
    authorization_servers: site.cfg.secretKey ? [issuerOf(site, s)] : [],
    bearer_methods_supported: ["header"],
    scopes_supported: splitScopes(site.cfg.defaultScopes),
    resource_name: `Mastodon (${s.instance})`,
    resource_documentation: `${site.base}/llms.txt`,
  };
}

export function authorizationServerMetadata(site: Site, s: Scope) {
  const iss = issuerOf(site, s);
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    registration_endpoint: `${iss}/oauth/register`,
    revocation_endpoint: `${iss}/oauth/revoke`,
    scopes_supported: splitScopes(site.cfg.appScopes),
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${site.base}/llms.txt`,
  };
}

// ---------- clients (DCR + CIMD) ----------

interface ClientInfo {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
}

const BAD_SCHEMES = /^(javascript|data|vbscript|file):/i;

function validRedirectUri(uri: string): boolean {
  if (BAD_SCHEMES.test(uri)) return false;
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    return true; // https or a private-use scheme (native apps)
  } catch {
    return false;
  }
}

/** Loopback redirect URIs may use any port (RFC 8252 §7.3). */
function redirectMatches(registered: string[], uri: string): boolean {
  if (registered.includes(uri)) return true;
  try {
    const u = new URL(uri);
    if (u.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return false;
    return registered.some((r) => {
      const ru = new URL(r);
      return ru.protocol === u.protocol && ru.hostname === u.hostname && ru.pathname === u.pathname && ru.search === u.search;
    });
  } catch {
    return false;
  }
}

async function fetchCimd(site: Site, clientId: string): Promise<ClientInfo | null> {
  const key = `cimd:v1:${await sha256b64url(clientId)}`;
  const cached = await getJson<ClientInfo>(site.store, key);
  if (cached) return cached;
  const u = new URL(clientId);
  if (u.protocol !== "https:" || u.pathname === "/" || u.hash) return null;
  normalizeInstance(u.host, { ...site.cfg, allowedInstances: [] }); // public-host guard
  const res = await fetch(u, { headers: { Accept: "application/json", "User-Agent": site.cfg.userAgent }, redirect: "error", signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const text = await res.text();
  if (text.length > 20000) return null;
  const doc = JSON.parse(text) as Partial<ClientInfo>;
  if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris) || !doc.redirect_uris.length) return null;
  const info: ClientInfo = { client_id: clientId, client_name: String(doc.client_name ?? u.host).slice(0, 100), redirect_uris: doc.redirect_uris.filter(validRedirectUri) };
  await putJson(site.store, key, info, 3600);
  return info;
}

async function resolveClient(site: Site, clientId: string): Promise<ClientInfo | null> {
  if (clientId.startsWith("https://")) {
    try {
      return await fetchCimd(site, clientId);
    } catch {
      return null;
    }
  }
  const p = await unseal<{ r: string[]; n?: string }>(site.cfg.secretKey!, "c", clientId);
  return p ? { client_id: clientId, client_name: p.n, redirect_uris: p.r } : null;
}

// ---------- helpers ----------

function oauthError(c: Context, status: number, error: string, description: string) {
  return c.json({ error, error_description: description }, status as 400);
}

function redirectWith(uri: string, params: Record<string, string | undefined>) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Accept the canonical resource with or without trailing slash / case differences in scheme+host. */
function resourceOk(site: Site, s: Scope, resource: string | undefined): boolean {
  if (!resource) return true;
  const norm = (x: string) => {
    try {
      const u = new URL(x);
      return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
    } catch {
      return x.toLowerCase();
    }
  };
  return norm(resource) === norm(resourceOf(site, s)) || norm(resource) === norm(issuerOf(site, s));
}

async function readForm(c: Context): Promise<Record<string, string>> {
  const ct = c.req.header("content-type") ?? "";
  if (ct.includes("application/json")) {
    const j = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v)]));
  }
  const body = await c.req.parseBody().catch(() => ({}));
  return Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === "string")) as Record<string, string>;
}

function requireSecret(site: Site, c: Context) {
  if (!site.cfg.secretKey) return oauthError(c, 501, "temporarily_unavailable", "OAuth is disabled: set SECRET_KEY on the server");
  return null;
}

// ---------- endpoints ----------

/** POST {issuer}/oauth/register — RFC 7591 DCR. Stateless: client_id is a sealed blob. */
export async function register(c: Context, site: Site) {
  const off = requireSecret(site, c);
  if (off) return off;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return oauthError(c, 400, "invalid_client_metadata", "JSON body required");
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 10 || !uris.every(validRedirectUri)) {
    return oauthError(c, 400, "invalid_redirect_uri", "redirect_uris must be https, loopback http, or a private-use scheme");
  }
  const name = typeof body.client_name === "string" ? body.client_name.slice(0, 100) : undefined;
  const client_id = await seal(site.cfg.secretKey!, "c", { r: uris, n: name });
  return c.json(
    {
      client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    201,
  );
}

interface Flow extends Record<string, unknown> {
  i: string; // instance
  p: string; // prefix
  cid: string; // client_id
  cn?: string; // client name
  ru: string; // client redirect_uri
  st?: string; // client state
  cc: string; // client code_challenge
  sc: string; // scope requested from Mastodon
  uv: string; // upstream PKCE verifier
  n: string; // CSRF nonce (matches cookie)
}

const CSRF_COOKIE = "mmcp_csrf";

/** GET {issuer}/oauth/authorize — validate, then render a consent page naming the client. */
export async function authorize(c: Context, site: Site, s: Scope) {
  const off = requireSecret(site, c);
  if (off) return off;
  const q = c.req.query();
  const client = q.client_id ? await resolveClient(site, q.client_id) : null;
  if (!client) return c.text("Unknown client_id", 400);
  if (!q.redirect_uri || !redirectMatches(client.redirect_uris, q.redirect_uri)) return c.text("redirect_uri is not registered for this client", 400);
  const iss = issuerOf(site, s);
  const fail = (error: string, desc: string) => c.redirect(redirectWith(q.redirect_uri, { error, error_description: desc, state: q.state, iss }));
  if (q.response_type !== "code") return fail("unsupported_response_type", "response_type must be code");
  if (!q.code_challenge || (q.code_challenge_method ?? "plain") !== "S256") return fail("invalid_request", "PKCE with S256 is required");
  if (!resourceOk(site, s, q.resource)) return fail("invalid_target", `resource must be ${resourceOf(site, s)}`);

  let app;
  try {
    app = await getApp(site.cfg, site.store, s.instance, callbackUrl(site));
  } catch (e) {
    return fail("temporarily_unavailable", e instanceof Error ? e.message : String(e));
  }
  const requested = splitScopes(q.scope).filter((x) => x !== "offline_access");
  const wanted = requested.length ? requested : splitScopes(site.cfg.defaultScopes);
  const granted = wanted.filter((x) => allowedByApp(app.scopes, x));
  if (!granted.length) return fail("invalid_scope", `none of the requested scopes are available; allowed: ${app.scopes.join(" ")}`);

  const nonce = randomToken(16);
  const flow: Flow = {
    i: s.instance, p: s.prefix, cid: client.client_id, cn: client.client_name, ru: q.redirect_uri, st: q.state,
    cc: q.code_challenge, sc: granted.join(" "), uv: randomToken(48), n: nonce,
  };
  const sealed = await seal(site.cfg.secretKey!, "s", flow, FLOW_TTL);
  const secure = site.base.startsWith("https:");
  c.header("Set-Cookie", `${CSRF_COOKIE}=${nonce}; Path=/oauth; HttpOnly; SameSite=Lax; Max-Age=${FLOW_TTL}${secure ? "; Secure" : ""}`);
  c.header("X-Frame-Options", "DENY");
  c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http:; frame-ancestors 'none'");
  c.header("Cache-Control", "no-store");
  const redirectHost = (() => {
    try {
      return new URL(q.redirect_uri).host || q.redirect_uri;
    } catch {
      return q.redirect_uri;
    }
  })();
  const adminScopes = granted.filter((x) => x.startsWith("admin:"));
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize ${esc(client.client_name ?? "MCP client")}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#222}code{background:#f2f2f2;padding:.1rem .3rem;border-radius:3px;word-break:break-all}.warn{color:#a40}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem;cursor:pointer}</style></head><body>
<h1>Connect to ${esc(s.instance)}</h1>
<p><strong>${esc(client.client_name ?? "An MCP client")}</strong> wants to access your Mastodon account on <strong>${esc(s.instance)}</strong>.</p>
<p>After you continue, you will sign in on ${esc(s.instance)}, and the client will receive access via <code>${esc(redirectHost)}</code>.</p>
<p>Requested scopes: <code>${esc(granted.join(" "))}</code></p>
${adminScopes.length ? `<p class="warn">Includes moderation/admin scopes. They only work if your account has the matching staff role.</p>` : ""}
<p>Only continue if you started this connection yourself.</p>
<form method="post" action="${esc(site.base)}/oauth/consent"><input type="hidden" name="flow" value="${esc(sealed)}">
<button type="submit" name="decision" value="allow">Continue to ${esc(s.instance)}</button><button type="submit" name="decision" value="deny">Cancel</button></form>
</body></html>`);
}

function getCookie(c: Context, name: string): string | undefined {
  const raw = c.req.header("cookie") ?? "";
  for (const part of raw.split(/;\s*/)) {
    const [k, ...v] = part.split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

/** POST /oauth/consent — CSRF-checked; redirects to Mastodon's authorize page. */
export async function consent(c: Context, site: Site) {
  const off = requireSecret(site, c);
  if (off) return off;
  const form = await readForm(c);
  const flow = await unseal<Flow>(site.cfg.secretKey!, "s", form.flow ?? "");
  if (!flow) return c.text("Authorization request expired; start again from your MCP client.", 400);
  const cookie = getCookie(c, CSRF_COOKIE);
  if (!cookie || cookie !== flow.n) return c.text("Consent could not be verified (cookie missing). Start again from your MCP client.", 403);
  const iss = `${site.base}${flow.p}`;
  if (form.decision !== "allow") {
    return c.redirect(redirectWith(flow.ru, { error: "access_denied", error_description: "user denied the request", state: flow.st, iss }));
  }
  const app = await getApp(site.cfg, site.store, flow.i, callbackUrl(site));
  const state = await seal(site.cfg.secretKey!, "s", { ...flow, n: "" }, FLOW_TTL);
  const url = new URL(`${instanceBaseUrl(flow.i, site.cfg)}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: app.client_id,
    redirect_uri: callbackUrl(site),
    scope: flow.sc,
    state,
    code_challenge: await sha256b64url(flow.uv),
    code_challenge_method: "S256",
  }).toString();
  c.header("Set-Cookie", `${CSRF_COOKIE}=; Path=/oauth; Max-Age=0`);
  return c.redirect(url.toString(), 303);
}

/** GET /oauth/callback — exchange Mastodon's code, mint our own code for the MCP client. */
export async function callback(c: Context, site: Site) {
  const off = requireSecret(site, c);
  if (off) return off;
  const q = c.req.query();
  const flow = await unseal<Flow>(site.cfg.secretKey!, "s", q.state ?? "");
  if (!flow) return c.text("Authorization state invalid or expired; start again from your MCP client.", 400);
  const iss = `${site.base}${flow.p}`;
  const back = (params: Record<string, string | undefined>) => c.redirect(redirectWith(flow.ru, { ...params, state: flow.st, iss }));
  if (q.error) return back({ error: q.error, error_description: q.error_description });
  if (!q.code) return back({ error: "server_error", error_description: "no code from Mastodon" });

  let app;
  try {
    app = await getApp(site.cfg, site.store, flow.i, callbackUrl(site));
  } catch (e) {
    return back({ error: "temporarily_unavailable", error_description: e instanceof UpstreamError ? e.message : "app registration failed" });
  }
  const res = await fetch(`${instanceBaseUrl(flow.i, site.cfg)}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": site.cfg.userAgent },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: q.code,
      client_id: app.client_id,
      client_secret: app.client_secret,
      redirect_uri: callbackUrl(site),
      code_verifier: flow.uv,
    }),
    signal: AbortSignal.timeout(site.cfg.upstreamTimeoutMs),
  });
  const tok = (await res.json().catch(() => ({}))) as { access_token?: string; scope?: string; error?: string; error_description?: string };
  if (!res.ok || !tok.access_token) return back({ error: "access_denied", error_description: tok.error_description ?? tok.error ?? `token exchange failed (${res.status})` });

  const code = await seal(
    site.cfg.secretKey!,
    "k",
    { i: flow.i, t: tok.access_token, s: tok.scope ?? flow.sc, c: flow.cid, ru: flow.ru, cc: flow.cc, ap: [app.client_id, app.client_secret], j: randomToken(12) },
    CODE_TTL,
  );
  return back({ code });
}

async function mintTokens(site: Site, p: AccessTokenPayload) {
  const ttl = site.cfg.tokenTtlSeconds;
  return {
    access_token: await seal(site.cfg.secretKey!, "a", p, ttl),
    token_type: "Bearer",
    expires_in: ttl,
    refresh_token: await seal(site.cfg.secretKey!, "r", p),
    scope: p.s,
  };
}

/** POST {issuer}/oauth/token */
export async function token(c: Context, site: Site, s: Scope) {
  const off = requireSecret(site, c);
  if (off) return off;
  c.header("Cache-Control", "no-store");
  const f = await readForm(c);
  if (!resourceOk(site, s, f.resource)) return oauthError(c, 400, "invalid_target", `resource must be ${resourceOf(site, s)}`);

  if (f.grant_type === "authorization_code") {
    const p = await unseal<AccessTokenPayload & { ru: string; cc: string; j: string }>(site.cfg.secretKey!, "k", f.code ?? "");
    if (!p) return oauthError(c, 400, "invalid_grant", "code invalid or expired");
    if (p.i !== s.instance) return oauthError(c, 400, "invalid_grant", "code was issued for a different instance");
    if (f.client_id && f.client_id !== p.c) return oauthError(c, 400, "invalid_grant", "client_id mismatch");
    if (f.redirect_uri && f.redirect_uri !== p.ru) return oauthError(c, 400, "invalid_grant", "redirect_uri mismatch");
    if (!f.code_verifier || !(await verifyPkce(f.code_verifier, p.cc))) return oauthError(c, 400, "invalid_grant", "PKCE verification failed");
    // Single use (best effort; the store may be per-isolate memory).
    const usedKey = `code:${p.j}`;
    if (await site.store.get(usedKey)) return oauthError(c, 400, "invalid_grant", "code already used");
    await site.store.put(usedKey, "1", CODE_TTL);
    return c.json(await mintTokens(site, { i: p.i, t: p.t, s: p.s, c: p.c, ap: p.ap }));
  }

  if (f.grant_type === "refresh_token") {
    const p = await unseal<AccessTokenPayload>(site.cfg.secretKey!, "r", f.refresh_token ?? "");
    if (!p) return oauthError(c, 400, "invalid_grant", "refresh_token invalid");
    if (p.i !== s.instance) return oauthError(c, 400, "invalid_grant", "refresh_token was issued for a different instance");
    if (f.client_id && f.client_id !== p.c) return oauthError(c, 400, "invalid_grant", "client_id mismatch");
    // Optional down-scoping per RFC 6749 §6.
    const req = splitScopes(f.scope);
    const granted = splitScopes(p.s);
    const s2 = req.length ? req.filter((x) => granted.includes(x)) : granted;
    if (req.length && !s2.length) return oauthError(c, 400, "invalid_scope", "requested scope exceeds the original grant");
    return c.json(await mintTokens(site, { ...p, s: s2.join(" ") }));
  }

  return oauthError(c, 400, "unsupported_grant_type", "supported: authorization_code, refresh_token");
}

/** POST {issuer}/oauth/revoke — revokes the underlying Mastodon token (RFC 7009: always 200). */
export async function revoke(c: Context, site: Site) {
  const off = requireSecret(site, c);
  if (off) return off;
  const f = await readForm(c);
  const t = f.token ?? "";
  const p = (await unseal<AccessTokenPayload>(site.cfg.secretKey!, "a", t)) ?? (await unseal<AccessTokenPayload>(site.cfg.secretKey!, "r", t));
  if (p?.ap) {
    await fetch(`${instanceBaseUrl(p.i, site.cfg)}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": site.cfg.userAgent },
      body: new URLSearchParams({ token: p.t, client_id: p.ap[0], client_secret: p.ap[1] }),
      signal: AbortSignal.timeout(site.cfg.upstreamTimeoutMs),
    }).catch(() => {});
  }
  return c.body(null, 200);
}
