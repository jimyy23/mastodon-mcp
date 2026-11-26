import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256b64url } from "../src/auth/crypto.ts";
import { callTool, json, makeApp, mockUpstream } from "./helpers.ts";

afterEach(() => vi.unstubAllGlobals());

const VERIFIER = "v".repeat(50);

function fakeMastodon() {
  return mockUpstream((c) => {
    if (c.url.endsWith("/.well-known/oauth-authorization-server")) return json({ scopes_supported: ["read", "read:statuses", "write", "write:statuses", "follow", "push", "profile", "admin:read", "admin:write"] });
    if (c.url.endsWith("/api/v1/apps")) return json({ client_id: "mcid", client_secret: "mcsecret" });
    if (c.url.endsWith("/oauth/token")) return json({ access_token: "real-mastodon-token", scope: "read write", token_type: "Bearer" });
    if (c.url.endsWith("/oauth/revoke")) return json({});
    if (c.url.includes("/api/v1/accounts/verify_credentials")) {
      return c.headers.authorization === "Bearer real-mastodon-token" ? json({ id: "1", username: "me", acct: "me" }) : json({ error: "bad" }, { status: 401 });
    }
    return undefined;
  });
}

async function fullFlow(app: ReturnType<typeof makeApp>["app"], redirect = "http://127.0.0.1:5555/cb") {
  // 1. DCR
  const reg = await app.request("http://mcp.test/mastodon.example/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test Client", redirect_uris: [redirect] }),
  });
  expect(reg.status).toBe(201);
  const { client_id } = await reg.json();

  // 2. authorize -> consent page
  const challenge = await sha256b64url(VERIFIER);
  const q = new URLSearchParams({
    response_type: "code", client_id, redirect_uri: redirect, state: "xyz", code_challenge: challenge, code_challenge_method: "S256",
    scope: "read write", resource: "http://mcp.test/mastodon.example/mcp",
  });
  const auth = await app.request(`http://mcp.test/mastodon.example/oauth/authorize?${q}`);
  expect(auth.status).toBe(200);
  const html = await auth.text();
  expect(html).toContain("Test Client");
  expect(html).toContain("mastodon.example");
  const flow = html.match(/name="flow" value="([^"]+)"/)![1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  const cookie = auth.headers.get("set-cookie")!.split(";")[0];

  // 3. consent -> Mastodon authorize
  const consent = await app.request("http://mcp.test/oauth/consent", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ flow, decision: "allow" }),
  });
  expect(consent.status).toBe(303);
  const up = new URL(consent.headers.get("location")!);
  expect(up.origin + up.pathname).toBe("https://mastodon.example/oauth/authorize");
  expect(up.searchParams.get("client_id")).toBe("mcid");
  expect(up.searchParams.get("scope")).toBe("read write");
  expect(up.searchParams.get("code_challenge_method")).toBe("S256");

  // 4. Mastodon redirects back to our callback
  const cb = await app.request(`http://mcp.test/oauth/callback?code=upcode&state=${encodeURIComponent(up.searchParams.get("state")!)}`);
  expect(cb.status).toBe(302);
  const back = new URL(cb.headers.get("location")!);
  expect(back.origin + back.pathname).toBe("http://127.0.0.1:5555/cb");
  expect(back.searchParams.get("state")).toBe("xyz");
  expect(back.searchParams.get("iss")).toBe("http://mcp.test/mastodon.example");
  const code = back.searchParams.get("code")!;

  // 5. token exchange with PKCE
  const tok = await app.request("http://mcp.test/mastodon.example/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id, redirect_uri: redirect, code_verifier: VERIFIER, resource: "http://mcp.test/mastodon.example/mcp" }),
  });
  return { tok, code, client_id, redirect };
}

describe("OAuth facade", () => {
  it("publishes RFC 8414 metadata (path insertion and appending)", async () => {
    const { app } = makeApp();
    for (const p of ["/.well-known/oauth-authorization-server/mastodon.example", "/mastodon.example/.well-known/oauth-authorization-server", "/.well-known/openid-configuration/mastodon.example"]) {
      const m = await (await app.request(`http://mcp.test${p}`)).json();
      expect(m.issuer).toBe("http://mcp.test/mastodon.example");
      expect(m.code_challenge_methods_supported).toEqual(["S256"]);
      expect(m.client_id_metadata_document_supported).toBe(true);
    }
  });

  it("completes DCR + PKCE flow and the sealed token works for MCP calls", async () => {
    const calls = fakeMastodon();
    const { app } = makeApp();
    const { tok, code, client_id, redirect } = await fullFlow(app);
    expect(tok.status).toBe(200);
    const t = await tok.json();
    expect(t.access_token).toMatch(/^mmcp\.a\./);
    expect(t.refresh_token).toMatch(/^mmcp\.r\./);
    expect(t.access_token).not.toContain("real-mastodon-token");

    // The upstream token exchange used PKCE + our callback.
    const exch = calls.find((c) => c.url.endsWith("/oauth/token"))!;
    expect((exch.body as Record<string, string>).code_verifier).toBeTruthy();
    expect((exch.body as Record<string, string>).redirect_uri).toBe("http://mcp.test/oauth/callback");

    // Code is single-use.
    const again = await app.request("http://mcp.test/mastodon.example/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id, redirect_uri: redirect, code_verifier: VERIFIER }),
    });
    expect(again.status).toBe(400);

    // MCP call with our token -> upstream sees the real Mastodon token.
    const r = await callTool(app, "mastodon_api_call", { id: "accounts.verify_credentials" }, { auth: `Bearer ${t.access_token}` });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).acct).toBe("me");

    // Token is audience-bound to the instance.
    const wrong = await callTool(app, "mastodon_api_call", { id: "accounts.verify_credentials" }, { auth: `Bearer ${t.access_token}`, path: "/other.example/mcp" });
    expect(wrong.status).toBe(401);

    // Refresh works and preserves the grant.
    const ref = await app.request("http://mcp.test/mastodon.example/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id }),
    });
    expect(ref.status).toBe(200);
    expect((await ref.json()).scope).toBe("read write");

    // Revoke calls Mastodon's revoke with the real token.
    await app.request("http://mcp.test/mastodon.example/oauth/revoke", { method: "POST", body: new URLSearchParams({ token: t.access_token }) });
    const rev = calls.find((c) => c.url.endsWith("/oauth/revoke"))!;
    expect((rev.body as Record<string, string>).token).toBe("real-mastodon-token");
  });

  it("SCOPE_STEP_UP turns upstream scope errors into HTTP 403 insufficient_scope", async () => {
    fakeMastodon();
    const { app } = makeApp({ SCOPE_STEP_UP: "true" });
    const t = await (await fullFlow(app)).tok.json();
    mockUpstream(() => json({ error: "This action is outside the authorized scopes" }, { status: 403 }));
    const r = await callTool(app, "mastodon_api_call", { id: "admin.reports.get" }, { auth: `Bearer ${t.access_token}` });
    expect(r.status).toBe(403);
    const h = r.raw.headers.get("www-authenticate")!;
    expect(h).toContain('error="insufficient_scope"');
    expect(h).toContain('scope="read write admin:read:reports"');
  });

  it("rejects forged codes and wrong PKCE verifiers", async () => {
    fakeMastodon();
    const { app } = makeApp();
    const token = (body: Record<string, string>) =>
      app.request("http://mcp.test/mastodon.example/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });

    const forged = await token({ grant_type: "authorization_code", code: "mmcp.k.garbage", code_verifier: VERIFIER });
    expect(forged.status).toBe(400);
    expect((await forged.json()).error).toBe("invalid_grant");

    // Run the flow up to the code, then redeem with the wrong verifier.
    const reg = await app.request("http://mcp.test/mastodon.example/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://localhost:1/cb"] }) });
    const { client_id } = await reg.json();
    const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "http://localhost:1/cb", code_challenge: await sha256b64url(VERIFIER), code_challenge_method: "S256" });
    const auth = await app.request(`http://mcp.test/mastodon.example/oauth/authorize?${q}`);
    const flow = (await auth.text()).match(/name="flow" value="([^"]+)"/)![1];
    const consent = await app.request("http://mcp.test/oauth/consent", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: auth.headers.get("set-cookie")!.split(";")[0] },
      body: new URLSearchParams({ flow, decision: "allow" }),
    });
    const state = new URL(consent.headers.get("location")!).searchParams.get("state")!;
    const cb = await app.request(`http://mcp.test/oauth/callback?code=c&state=${encodeURIComponent(state)}`);
    const code = new URL(cb.headers.get("location")!).searchParams.get("code")!;
    const wrong = await token({ grant_type: "authorization_code", code, client_id, code_verifier: "w".repeat(50) });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error_description).toContain("PKCE");
  });

  it("denied consent redirects back with access_denied", async () => {
    fakeMastodon();
    const { app } = makeApp();
    const reg = await app.request("http://mcp.test/mastodon.example/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://localhost:1/cb"] }) });
    const { client_id } = await reg.json();
    const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "http://localhost:1/cb", state: "s1", code_challenge: await sha256b64url(VERIFIER), code_challenge_method: "S256" });
    const auth = await app.request(`http://mcp.test/mastodon.example/oauth/authorize?${q}`);
    const flow = (await auth.text()).match(/name="flow" value="([^"]+)"/)![1];
    const res = await app.request("http://mcp.test/oauth/consent", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: auth.headers.get("set-cookie")!.split(";")[0] },
      body: new URLSearchParams({ flow, decision: "deny" }),
    });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("s1");
  });

  it("refuses unregistered redirect URIs and missing PKCE", async () => {
    fakeMastodon();
    const { app } = makeApp();
    const reg = await app.request("http://mcp.test/mastodon.example/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://app.example/cb"] }) });
    const { client_id } = await reg.json();
    const bad = await app.request(`http://mcp.test/mastodon.example/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id, redirect_uri: "https://evil.example/cb", code_challenge: "x", code_challenge_method: "S256" })}`);
    expect(bad.status).toBe(400);
    const nopkce = await app.request(`http://mcp.test/mastodon.example/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id, redirect_uri: "https://app.example/cb" })}`);
    expect(nopkce.status).toBe(302);
    expect(nopkce.headers.get("location")).toContain("error=invalid_request");
  });

  it("rejects DCR with unsafe redirect URIs", async () => {
    const { app } = makeApp();
    for (const uri of ["http://evil.example/cb", "javascript:alert(1)"]) {
      const r = await app.request("http://mcp.test/mastodon.example/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [uri] }) });
      expect(r.status, uri).toBe(400);
    }
  });

  it("consent without the CSRF cookie is refused", async () => {
    fakeMastodon();
    const { app } = makeApp();
    const reg = await app.request("http://mcp.test/mastodon.example/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://localhost:9/cb"] }) });
    const { client_id } = await reg.json();
    const auth = await app.request(`http://mcp.test/mastodon.example/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id, redirect_uri: "http://localhost:9/cb", code_challenge: await sha256b64url(VERIFIER), code_challenge_method: "S256" })}`);
    const flow = (await auth.text()).match(/name="flow" value="([^"]+)"/)![1];
    const c = await app.request("http://mcp.test/oauth/consent", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ flow, decision: "allow" }) });
    expect(c.status).toBe(403);
  });

  it("supports Client ID Metadata Documents", async () => {
    mockUpstream((c) => {
      if (c.url === "https://client.example/mcp.json") return json({ client_id: "https://client.example/mcp.json", client_name: "CIMD App", redirect_uris: ["http://127.0.0.1/cb"] });
      if (c.url.endsWith("/.well-known/oauth-authorization-server")) return json({ scopes_supported: ["read", "write", "profile"] });
      if (c.url.endsWith("/api/v1/apps")) return json({ client_id: "a", client_secret: "b" });
      return undefined;
    });
    const { app } = makeApp();
    const res = await app.request(
      `http://mcp.test/mastodon.example/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: "https://client.example/mcp.json", redirect_uri: "http://127.0.0.1:4321/cb", code_challenge: await sha256b64url(VERIFIER), code_challenge_method: "S256" })}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("CIMD App");
  });

  it("OAuth is disabled cleanly without SECRET_KEY", async () => {
    const { app } = makeApp({ SECRET_KEY: "" });
    expect((await app.request("http://mcp.test/.well-known/oauth-authorization-server/mastodon.example")).status).toBe(404);
    const prm = await (await app.request("http://mcp.test/.well-known/oauth-protected-resource/mastodon.example/mcp")).json();
    expect(prm.authorization_servers).toEqual([]);
  });
});

describe("credential modes", () => {
  it("API key maps to a server-side token (mixed with X-Mastodon-Token override)", async () => {
    const calls = mockUpstream(() => json({ id: "1", username: "u", acct: "u" }));
    const { app } = makeApp({ MCP_API_KEYS: "key1", MASTODON_TOKENS: JSON.stringify({ "mastodon.example": "server-token" }) });
    await callTool(app, "mastodon_api_call", { id: "accounts.verify_credentials" }, { auth: "Bearer key1" });
    expect(calls[0].headers.authorization).toBe("Bearer server-token");
    await callTool(app, "mastodon_api_call", { id: "accounts.verify_credentials" }, { auth: "Bearer key1", headers: { "x-mastodon-token": "user-token" } });
    expect(calls[1].headers.authorization).toBe("Bearer user-token");
  });

  it("passthrough can be disabled", async () => {
    const { app } = makeApp({ ALLOW_PASSTHROUGH: "false" });
    const r = await callTool(app, "mastodon_api_search", {}, { auth: "Bearer raw" });
    expect(r.status).toBe(401);
  });

  it("default instance route /mcp uses DEFAULT_INSTANCE and its own issuer", async () => {
    const calls = mockUpstream(() => json([]));
    const { app } = makeApp({ DEFAULT_INSTANCE: "home.example" });
    await callTool(app, "mastodon_api_call", { id: "timelines.home" }, { path: "/mcp" });
    expect(calls[0].url).toContain("https://home.example/");
    const prm = await (await app.request("http://mcp.test/.well-known/oauth-protected-resource/mcp")).json();
    expect(prm.authorization_servers).toEqual(["http://mcp.test"]);
  });
});
