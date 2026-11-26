import { afterEach, describe, expect, it, vi } from "vitest";
import { callTool, json, makeApp, mockUpstream } from "./helpers.ts";

afterEach(() => vi.unstubAllGlobals());

const STATUS = {
  id: "1",
  content: '<p>Hi <span class="h-card"><a href="https://a.example/@x" class="u-url mention">@<span>x</span></a></span> see <a href="https://news.example/story" rel="nofollow"><span class="invisible">https://</span><span class="ellipsis">news.example/sto</span><span class="invisible">ry</span></a></p>',
  account: { id: "9", username: "bob", acct: "bob", display_name: "Bob", avatar_static: "x", emojis: [], note: "<p>bio</p>" },
  media_attachments: [{ id: "m1", type: "image", url: "https://f/1.png", preview_url: "https://f/1s.png", blurhash: "x", description: null }],
  reblog: null,
  spoiler_text: "",
  emojis: [],
};

describe("mastodon_api_call", () => {
  it("compacts responses and returns paging cursors", async () => {
    const calls = mockUpstream((c) =>
      c.url.includes("/api/v1/timelines/home")
        ? json([STATUS], { headers: { link: '<https://mastodon.example/api/v1/timelines/home?max_id=1>; rel="next", <https://mastodon.example/api/v1/timelines/home?min_id=1>; rel="prev"' } })
        : undefined,
    );
    const { app } = makeApp();
    const r = await callTool(app, "mastodon_api_call", { id: "timelines.home", args: { limit: 5 } });
    expect(r.isError).toBe(false);
    expect(calls[0].url).toBe("https://mastodon.example/api/v1/timelines/home?limit=5");
    expect(calls[0].headers.authorization).toBe("Bearer mastotoken");
    const out = JSON.parse(r.text);
    expect(out.next).toEqual({ max_id: "1" });
    expect(out.count).toBe(1);
    const s = out.data[0];
    expect(s.content).toBe("Hi @x see https://news.example/story");
    expect(s.account).toEqual({ id: "9", acct: "bob", display_name: "Bob" });
    expect(s.media_attachments).toEqual([{ id: "m1", type: "image", url: "https://f/1.png" }]);
    expect(s).not.toHaveProperty("spoiler_text");
    expect(s).not.toHaveProperty("reblog");
  });

  it("supports select and format=full", async () => {
    mockUpstream(() => json([STATUS]));
    const { app } = makeApp();
    const sel = JSON.parse((await callTool(app, "mastodon_api_call", { id: "timelines.home", select: ["id", "account.acct"] })).text);
    expect(sel).toEqual({ count: 1, data: [{ id: "1", account: { acct: "bob" } }] });
    const full = JSON.parse((await callTool(app, "mastodon_api_call", { id: "timelines.home", format: "full" })).text);
    expect(full.data[0].account.avatar_static).toBe("x");
  });

  it("returns single objects bare (no envelope)", async () => {
    mockUpstream(() => json(STATUS));
    const { app } = makeApp();
    const one = JSON.parse((await callTool(app, "mastodon_api_call", { id: "statuses.get", args: { id: "1" }, select: ["id", "account.acct"] })).text);
    expect(one).toEqual({ id: "1", account: { acct: "bob" } });
  });

  it("encodes nested and flat bracket params as a Rails-compatible JSON body", async () => {
    const calls = mockUpstream((c) => (c.url.endsWith("/api/v1/statuses") ? json({ id: "2" }) : undefined));
    const { app } = makeApp();
    await callTool(app, "mastodon_api_call", {
      id: "statuses.create",
      args: { status: "hi", "media_ids[]": ["1"], poll: { options: ["a", "b"], expires_in: 60 } },
      idempotency_key: "k1",
    });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ status: "hi", media_ids: ["1"], poll: { options: ["a", "b"], expires_in: 60 } });
    expect(calls[0].headers["idempotency-key"]).toBe("k1");
    expect(calls[0].headers["content-type"]).toBe("application/json");
  });

  it("fills path params and encodes array query params", async () => {
    const calls = mockUpstream(() => json([]));
    const { app } = makeApp();
    await callTool(app, "mastodon_api_call", { id: "accounts.relationships", args: { id: ["1", "2"], with_suspended: true } });
    expect(decodeURIComponent(calls[0].url)).toBe("https://mastodon.example/api/v1/accounts/relationships?id[]=1&id[]=2&with_suspended=true");
    await callTool(app, "mastodon_api_call", { id: "accounts.statuses", args: { id: "42", limit: 2 } });
    expect(calls[1].url).toBe("https://mastodon.example/api/v1/accounts/42/statuses?limit=2");
  });

  it("reports missing path params and unknown ids helpfully", async () => {
    mockUpstream(() => json({}));
    const { app } = makeApp();
    const r = await callTool(app, "mastodon_api_call", { id: "statuses.get", args: {} });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("missing path parameter(s): id");
    const u = await callTool(app, "mastodon_api_call", { id: "statuses.gett" });
    expect(u.text).toContain("Did you mean");
  });

  it("uploads media from base64 as multipart", async () => {
    const calls = mockUpstream((c) => (c.url.endsWith("/api/v2/media") ? json({ id: "m9", type: "image", url: null, preview_url: "p" }, { status: 202 }) : undefined));
    const { app } = makeApp();
    const r = await callTool(app, "mastodon_api_call", { id: "media.v2", args: { file: { base64: btoa("PNGDATA"), filename: "a.png", mime: "image/png" }, description: "alt" } });
    expect(r.isError).toBe(false);
    const body = calls[0].body as Record<string, unknown>;
    expect(body.file).toBeInstanceOf(Blob);
    expect(await (body.file as Blob).text()).toBe("PNGDATA");
    expect(body.description).toBe("alt");
    expect(JSON.parse(r.text).status).toBe(202);
  });

  it("raw mode works and is restricted to API paths", async () => {
    const calls = mockUpstream(() => json({ ok: 1 }));
    const { app } = makeApp();
    const r = await callTool(app, "mastodon_api_call", { method: "GET", path: "/api/v1/new_thing?x=1", query: { y: 2 } });
    expect(r.isError).toBe(false);
    expect(calls[0].url).toBe("https://mastodon.example/api/v1/new_thing?x=1&y=2");
    const bad = await callTool(app, "mastodon_api_call", { method: "GET", path: "//evil.example/x" });
    expect(bad.isError).toBe(true);
    const bad2 = await callTool(app, "mastodon_api_call", { method: "GET", path: "/admin/accounts" });
    expect(bad2.isError).toBe(true);
  });

  it("follows pages when asked", async () => {
    let n = 0;
    mockUpstream(() => {
      n++;
      return json([{ id: String(n) }], { headers: n < 3 ? { link: `<https://mastodon.example/api/v1/favourites?max_id=${n}>; rel="next"` } : {} });
    });
    const { app } = makeApp();
    const out = JSON.parse((await callTool(app, "mastodon_api_call", { id: "favourites.get", pages: 5 })).text);
    expect(out.data.map((x: { id: string }) => x.id)).toEqual(["1", "2", "3"]);
    expect(out.pages).toBe(3);
  });

  it("surfaces upstream errors with hints and doc URLs", async () => {
    mockUpstream(() => json({ error: "This action is outside the authorized scopes" }, { status: 403 }));
    const { app } = makeApp();
    const r = await callTool(app, "mastodon_api_call", { id: "admin.accounts.v2" });
    expect(r.isError).toBe(true);
    const e = JSON.parse(r.text);
    expect(e.status).toBe(403);
    expect(e.hint).toContain("admin:read:accounts");
    expect(e.doc).toMatch(/^https:\/\/raw\.githubusercontent\.com\/mastodon\/documentation\/main\/content\/en\/methods\/admin\/accounts\.md$/);
  });

  it("READ_ONLY blocks writes; DISABLE_ADMIN hides admin endpoints", async () => {
    mockUpstream(() => json({}));
    const ro = makeApp({ READ_ONLY: "true" }).app;
    expect((await callTool(ro, "mastodon_api_call", { id: "statuses.create", args: { status: "x" } })).text).toContain("READ_ONLY");
    const na = makeApp({ DISABLE_ADMIN: "true" }).app;
    expect((await callTool(na, "mastodon_api_call", { id: "admin.reports.get" })).isError).toBe(true);
    expect((await callTool(na, "mastodon_api_call", { method: "GET", path: "/api/v1/admin/reports" })).text).toContain("disabled");
    const s = await callTool(na, "mastodon_api_search", { query: "suspend account" });
    expect(s.text).not.toContain("admin.");
  });

  it("anonymous calls defer to Mastodon and explain how to authenticate on 401", async () => {
    const calls = mockUpstream(() => json({ error: "This method requires an authenticated user" }, { status: 401 }));
    const { app } = makeApp({ AUTH_MODE: "optional" });
    const r = await callTool(app, "mastodon_api_call", { id: "timelines.home" }, { auth: undefined as unknown as string });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.text).hint).toContain("Requires authentication");
  });
});

describe("streaming", () => {
  it("collects SSE events from the instance's streaming host", async () => {
    const sse = 'event: update\ndata: {"id":"5","content":"<p>x</p>","account":{"id":"1","username":"a","acct":"a"}}\n\n:thump\n\nevent: delete\ndata: 4\n\n';
    const calls = mockUpstream((c) => {
      if (c.url.endsWith("/api/v2/instance")) return json({ configuration: { urls: { streaming: "wss://streaming.mastodon.example" } } });
      if (c.url.startsWith("https://streaming.mastodon.example/api/v1/streaming/public")) return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      return undefined;
    });
    const { app } = makeApp();
    const r = await callTool(app, "mastodon_api_call", { id: "streaming.public", args: { only_media: true }, seconds: 2, max_events: 5 });
    expect(r.isError).toBe(false);
    const out = JSON.parse(r.text);
    expect(out.events).toEqual([
      { event: "update", payload: { id: "5", content: "x", account: { id: "1", acct: "a" } } },
      { event: "delete", payload: 4 },
    ]);
    expect(calls.at(-1)!.url).toBe("https://streaming.mastodon.example/api/v1/streaming/public?only_media=true");
    expect(calls.at(-1)!.headers.authorization).toBe("Bearer mastotoken");
  });
});

describe("token budget", () => {
  it("default tools/list stays small", async () => {
    const { app } = makeApp({ AUTH_MODE: "optional" });
    const { rpc } = await import("./helpers.ts");
    const r = await rpc(app, "tools/list");
    // ~4 chars per token: keep the default surface under ~1.5k tokens.
    expect(JSON.stringify(r.body.result.tools).length).toBeLessThan(6000);
  });
});

describe("discovery tools", () => {
  it("search returns compact lines", async () => {
    const { app } = makeApp({ AUTH_MODE: "optional" });
    const r = await callTool(app, "mastodon_api_search", { query: "post a status" });
    expect(r.text.split("\n")[0]).toMatch(/^statuses\.create  POST \/api\/v1\/statuses/);
    const groups = await callTool(app, "mastodon_api_search", {});
    expect(groups.text).toContain("admin.accounts(");
  });

  it("describe includes params, raw doc URL and optional schema", async () => {
    const { app } = makeApp({ AUTH_MODE: "optional" });
    const r = await callTool(app, "mastodon_api_describe", { id: "statuses.create", schema: true });
    expect(r.text).toContain("poll.options[]: string[]");
    expect(r.text).toContain("doc: https://raw.githubusercontent.com/mastodon/documentation/main/content/en/methods/statuses.md #create");
    expect(r.text).toContain("entities/Status.md");
    expect(r.text).toContain('schema: {"type":"object"');
  });
});

describe("resources", () => {
  it("guide and catalog resources are readable", async () => {
    const { app } = makeApp({ AUTH_MODE: "optional" });
    const { rpc } = await import("./helpers.ts");
    const list = await rpc(app, "resources/list");
    expect(list.body.result.resources.map((r: { uri: string }) => r.uri)).toContain("mastodon://guide");
    const g = await rpc(app, "resources/read", { uri: "mastodon://guide" });
    expect(g.body.result.contents[0].text).toContain("raw.githubusercontent.com/mastodon/documentation");
    const e = await rpc(app, "resources/read", { uri: "mastodon://endpoint/admin.accounts.action" });
    expect(e.body.result.contents[0].text).toContain("POST /api/v1/admin/accounts/:id/action");
    const missing = await rpc(app, "resources/read", { uri: "mastodon://nope" });
    expect(missing.body.error.code).toBe(-32602);
  });
});
