import type { Config } from "../config.ts";
import { instanceBaseUrl } from "../instance.ts";
import { getJson, putJson, type Store } from "../store.ts";
import { sha256b64url } from "./crypto.ts";
import { expandAppScopes, splitScopes } from "./scopes.ts";

export interface MastodonApp {
  client_id: string;
  client_secret: string;
}

export class UpstreamError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
  }
}

/** Scopes the instance advertises (Mastodon >= 4.3). Cached for a day; [] if unknown. */
export async function instanceScopes(cfg: Config, store: Store, instance: string): Promise<string[]> {
  const key = `asmeta:v1:${instance}`;
  const cached = await getJson<string[]>(store, key);
  if (cached) return cached;
  let scopes: string[] = [];
  try {
    const res = await fetch(`${instanceBaseUrl(instance, cfg)}/.well-known/oauth-authorization-server`, {
      headers: { Accept: "application/json", "User-Agent": cfg.userAgent },
      signal: AbortSignal.timeout(Math.min(cfg.upstreamTimeoutMs, 10000)),
    });
    if (res.ok) scopes = ((await res.json()) as { scopes_supported?: string[] }).scopes_supported ?? [];
  } catch {}
  await putJson(store, key, scopes, scopes.length ? 86400 : 600);
  return scopes;
}

/**
 * Scopes we register our app with on this instance. Doorkeeper matches scopes as exact
 * strings, so granular scopes must be listed explicitly. Pre-4.3 instances (no metadata,
 * no `profile` scope) get the configured families only.
 */
export async function registrationScopes(cfg: Config, store: Store, instance: string): Promise<string[]> {
  const supported = await instanceScopes(cfg, store, instance);
  const configured = splitScopes(cfg.appScopes);
  if (!supported.length) return configured.filter((s) => s !== "profile");
  return expandAppScopes(configured, supported);
}

/**
 * Get (or register once and cache) this server's OAuth app on a Mastodon instance.
 * MASTODON_APPS presets win; otherwise POST /api/v1/apps. If the cache is lost a new
 * app is registered transparently; sealed tokens carry their own app credentials, so
 * existing tokens keep working.
 */
export async function getApp(cfg: Config, store: Store, instance: string, redirectUri: string): Promise<MastodonApp & { scopes: string[] }> {
  const scopes = await registrationScopes(cfg, store, instance);
  const preset = cfg.presetApps[instance];
  if (preset) return { ...preset, scopes };
  const key = `app:v1:${instance}:${await sha256b64url(`${redirectUri} ${scopes.join(" ")}`)}`;
  const cached = await getJson<MastodonApp>(store, key);
  if (cached) return { ...cached, scopes };
  const res = await fetch(`${instanceBaseUrl(instance, cfg)}/api/v1/apps`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": cfg.userAgent },
    body: JSON.stringify({ client_name: "Mastodon MCP", redirect_uris: redirectUri, scopes: scopes.join(" "), website: cfg.publicUrl }),
    signal: AbortSignal.timeout(cfg.upstreamTimeoutMs),
  });
  if (!res.ok) throw new UpstreamError(`registering OAuth app on ${instance} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as MastodonApp;
  if (!body.client_id || !body.client_secret) throw new UpstreamError(`unexpected app registration response from ${instance}`);
  const app = { client_id: body.client_id, client_secret: body.client_secret };
  await putJson(store, key, app);
  return { ...app, scopes };
}

/** App-level token (client_credentials) for endpoints documented as "App token". Cached. */
export async function getAppToken(cfg: Config, store: Store, instance: string, redirectUri: string): Promise<string | undefined> {
  const key = `apptoken:v1:${instance}`;
  const cached = await store.get(key);
  if (cached) return cached;
  try {
    const app = await getApp(cfg, store, instance, redirectUri);
    const res = await fetch(`${instanceBaseUrl(instance, cfg)}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": cfg.userAgent },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: app.client_id, client_secret: app.client_secret, scope: "read" }),
      signal: AbortSignal.timeout(cfg.upstreamTimeoutMs),
    });
    if (!res.ok) return undefined;
    const tok = ((await res.json()) as { access_token?: string }).access_token;
    if (tok) await store.put(key, tok, 86400);
    return tok;
  } catch {
    return undefined;
  }
}
