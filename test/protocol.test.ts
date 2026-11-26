import { afterEach, describe, expect, it, vi } from "vitest";
import { json, makeApp, mockUpstream, rpc } from "./helpers.ts";

afterEach(() => vi.unstubAllGlobals());

describe("MCP protocol (2026-07-28, stateless)", () => {
  it("server/discover advertises versions and caching fields", async () => {
    const { app } = makeApp({ AUTH_MODE: "optional" });
    const r = await rpc(app, "server/discover");
    expect(r.status).toBe(200);
    expect(r.body.result.resultType).toBe("complete");
    expect(r.body.result.supportedVersions).toContain("2026-07-28");
    expect(r.body.result.supportedVersions).toContain("2025-11-25");
    expect(r.body.result.ttlMs).toBeGreaterThan(0);
    expect(r.body.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("mastodon-mcp");
  });

  it("rejects unsupported versions with -32022", async () => {
    const { app } = makeApp({ AUTH_MODE: "optional" });
    const res = await app.request("http://mcp.test/mastodon.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": "1900-01-01", "mcp-method": "tools/list" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01", "io.modelcontextprotocol/clientCapabilities": {} } } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32022);
    expect(body.error.data.supported).toContain("2026-07-28");
  });

  it("enforces header/body agreement (-32020)", async () => {
    const { app } = makeApp({ AUTH_MODE: "optional" });
    const r = await rpc(app, "tools/call", { name: "mastodon_api_search", arguments: {} }, { headers: { "mcp-name": "other" } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe(-32020);
    const r2 = await rpc(app, "tools/list", {}, { headers: { "mcp-method": "tools/call" } });
    expect(r2.body.error.code).toBe(-32020);
  });

  it("decodes base64 Mcp-Name sentinel", async () => {
    const { app } = makeApp({ AUTH_MODE: "optional" });
    const r = await rpc(app, "tools/call", { name: "mastodon_api_search", arguments: {} }, { headers: { "mcp-name": `=?base64?${btoa("mastodon_api_search")}?=` } });
    expect(r.status).toBe(200);
  });

  it("returns 404 + -32601 for unknown methods", async () => {
    const { app } = makeApp({ AUTH_MODE: "optional" });
    const r = await rpc(app, "nope/nope");
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe(-32601);
  });

  it("tools/list is small by default and expands with ?expose=", async () => {
    const { app } = makeApp({ AUTH_MODE: "optional" });
    const r = await rpc(app, "tools/list");
    const tools = r.body.result.tools;
    expect(tools.map((t: { name: string }) => t.name)).toEqual(["mastodon_api_search", "mastodon_api_describe", "mastodon_api_call", "mastodon_auth"]);
    expect(JSON.stringify(tools).length).toBeLessThan(8000);
    expect(r.body.result.cacheScope).toBe("private");

    const r2 = await rpc(app, "tools/list", {}, { path: "/mastodon.example/mcp?expose=statuses" });
    const names = r2.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("m_statuses_create");
    expect(names.some((n: string) => n.startsWith("m_admin"))).toBe(false);
    const create = r2.body.result.tools.find((t: { name: string }) => t.name === "m_statuses_create");
    expect(create.inputSchema.properties.poll.properties.options.type).toBe("array");
  });

  it("GET/DELETE on the MCP endpoint return 405", async () => {
    const { app } = makeApp();
    expect((await app.request("http://mcp.test/mastodon.example/mcp")).status).toBe(405);
    expect((await app.request("http://mcp.test/mastodon.example/mcp", { method: "DELETE" })).status).toBe(405);
  });

  it("rejects foreign Origin headers", async () => {
    const { app } = makeApp({ AUTH_MODE: "optional" });
    const r = await rpc(app, "tools/list", {}, { headers: { origin: "https://evil.example" } });
    expect(r.status).toBe(403);
  });
});

describe("legacy (initialize-based) clients", () => {
  it("answers initialize without minting a session id, then serves tools/list", async () => {
    const { app } = makeApp({ AUTH_MODE: "optional" });
    const res = await app.request("http://mcp.test/mastodon.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const body = await res.json();
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.resultType).toBeUndefined();

    const notif = await app.request("http://mcp.test/mastodon.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(notif.status).toBe(202);

    const list = await app.request("http://mcp.test/mastodon.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect((await list.json()).result.tools.length).toBe(4);
  });

  it("negotiates down unknown initialize versions", async () => {
    const { app } = makeApp({ AUTH_MODE: "optional" });
    const res = await app.request("http://mcp.test/mastodon.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } }),
    });
    expect((await res.json()).result.protocolVersion).toBe("2025-11-25");
  });
});

describe("auth challenges", () => {
  it("401 with resource_metadata when credentials are required", async () => {
    const { app } = makeApp();
    const r = await rpc(app, "tools/list");
    expect(r.status).toBe(401);
    const h = r.headers.get("www-authenticate")!;
    expect(h).toContain('resource_metadata="http://mcp.test/.well-known/oauth-protected-resource/mastodon.example/mcp"');
    expect(h).toContain('scope="read write follow push profile"');
  });

  it("converts an upstream 401 on a client token into an HTTP 401", async () => {
    mockUpstream(() => json({ error: "The access token is invalid" }, { status: 401 }));
    const { app } = makeApp();
    const r = await rpc(app, "tools/call", { name: "mastodon_api_call", arguments: { id: "timelines.home" } }, { auth: "Bearer revoked" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("protected resource metadata lists this server as the authorization server", async () => {
    const { app } = makeApp();
    const res = await app.request("http://mcp.test/.well-known/oauth-protected-resource/mastodon.example/mcp");
    const body = await res.json();
    expect(body.resource).toBe("http://mcp.test/mastodon.example/mcp");
    expect(body.authorization_servers).toEqual(["http://mcp.test/mastodon.example"]);
  });

  it("rejects private instance domains (SSRF guard)", async () => {
    const { app } = makeApp({ AUTH_MODE: "optional" });
    for (const d of ["localhost", "127.0.0.1", "10.0.0.1", "foo.internal", "[::1]"]) {
      const res = await app.request(`http://mcp.test/${encodeURIComponent(d)}/mcp`, { method: "POST", body: "{}" });
      expect(res.status, d).toBe(403);
    }
  });

  it("honors ALLOWED_INSTANCES", async () => {
    const { app } = makeApp({ AUTH_MODE: "optional", ALLOWED_INSTANCES: "mastodon.social" });
    expect((await rpc(app, "tools/list")).status).toBe(403);
    expect((await rpc(app, "tools/list", {}, { path: "/mastodon.social/mcp" })).status).toBe(200);
  });
});
