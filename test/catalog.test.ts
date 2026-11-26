import { describe, expect, it } from "vitest";
import { ENDPOINTS, getEndpoint, matchPath, paramsSchema, search } from "../src/catalog/index.ts";
import { compact, htmlToText, select } from "../src/mastodon/format.ts";
import { toQueryString, unflatten } from "../src/mastodon/params.ts";
import { hasScope, satisfies } from "../src/auth/scopes.ts";

describe("catalog integrity", () => {
  it("has unique ids and covers core + admin areas", () => {
    const ids = ENDPOINTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ENDPOINTS.length).toBeGreaterThan(250);
    for (const id of ["statuses.create", "timelines.home", "accounts.verify_credentials", "media.v2", "search.v2", "admin.accounts.action", "admin.reports.resolve", "admin.domain_blocks.create", "oauth.token", "streaming.user"]) {
      expect(getEndpoint(id), id).toBeTruthy();
    }
  });

  it("every endpoint has method, path, doc and declared path params", () => {
    for (const ep of ENDPOINTS) {
      expect(["GET", "POST", "PUT", "PATCH", "DELETE"]).toContain(ep.method);
      expect(ep.path.startsWith("/")).toBe(true);
      expect(ep.doc).toBeTruthy();
      for (const m of ep.path.matchAll(/:([a-z_]+)/g)) {
        expect(ep.params.some((p) => p.in === "path" && p.name === m[1]), `${ep.id} :${m[1]}`).toBe(true);
      }
    }
  });

  it("matchPath resolves concrete paths", () => {
    expect(matchPath("POST", "/api/v1/statuses/123/favourite")?.ep.id).toBe("statuses.favourite");
    expect(matchPath("POST", "/api/v1/statuses/123/favourite")?.pathParams).toEqual({ id: "123" });
    expect(matchPath("GET", "/api/v1/nope")).toBeUndefined();
  });

  it("builds nested schemas from bracket names", () => {
    const s = paramsSchema(getEndpoint("filters.create")!.params) as any;
    expect(s.properties.context.type).toBe("array");
    expect(s.properties.keywords_attributes.items.properties.keyword.type).toBe("string");
    const u = paramsSchema(getEndpoint("accounts.update_credentials")!.params) as any;
    expect(u.properties.source.properties.privacy.enum).toEqual(["public", "unlisted", "private"]);
    expect(u.properties.fields_attributes.type).toBe("array");
  });

  it("search finds the obvious endpoint first", () => {
    const top = (q: string) => search(q, { includeAdmin: true, limit: 1 })[0]?.id;
    expect(top("post status")).toBe("statuses.create");
    expect(top("home timeline")).toBe("timelines.home");
    expect(top("who am i")).toBe("accounts.verify_credentials");
    expect(top("upload image")).toBe("media.v2");
    expect(top("like")).toBe("statuses.favourite");
  });
});

describe("params", () => {
  it("unflattens bracket names", () => {
    expect(unflatten({ "poll[options][]": ["a"], "poll[expires_in]": 5, "media_ids[]": "1", x: 1 })).toEqual({ poll: { options: ["a"], expires_in: 5 }, media_ids: ["1"], x: 1 });
  });
  it("encodes Rails query strings", () => {
    expect(decodeURIComponent(toQueryString({ types: ["mention", "follow"], a: { b: true } }))).toBe("?types[]=mention&types[]=follow&a[b]=true");
  });
});

describe("format", () => {
  it("htmlToText keeps mentions and full link URLs", () => {
    expect(htmlToText('<p>a &amp; b</p><p>c<br>d</p>')).toBe("a & b\n\nc\nd");
  });
  it("compact keeps top-level accounts intact but shrinks nested ones", () => {
    const acct = { id: "1", username: "a", acct: "a", display_name: "A", note: "<p>hi</p>", followers_count: 3, emojis: [] };
    expect(compact(acct)).toEqual({ id: "1", username: "a", acct: "a", display_name: "A", note: "hi", followers_count: 3 });
    expect(compact({ id: "s", account: acct })).toEqual({ id: "s", account: { id: "1", acct: "a", display_name: "A" } });
  });
  it("select projects through arrays", () => {
    expect(select([{ a: 1, b: { c: 2, d: 3 } }], ["a", "b.c"])).toEqual([{ a: 1, b: { c: 2 } }]);
  });
});

describe("scopes", () => {
  it("understands hierarchy and follow alias", () => {
    expect(hasScope(["read"], "read:statuses")).toBe(true);
    expect(hasScope(["admin:read"], "admin:read:accounts")).toBe(true);
    expect(hasScope(["follow"], "write:blocks")).toBe(true);
    expect(hasScope(["read:accounts"], "read:statuses")).toBe(false);
    expect(satisfies(["write:follows"], ["write:follows", "follow"])).toBe(true);
  });
});
