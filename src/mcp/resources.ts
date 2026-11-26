import { CATALOG_META, docUrls, ENDPOINTS, getEndpoint, groups, isAdmin } from "../catalog/index.ts";
import { DOCS_RAW_BASE } from "../version.ts";
import type { McpContext } from "./context.ts";
import { describeEndpoint, endpointLine } from "./tools.ts";

/**
 * Resources are read on demand, so they cost nothing until used.
 *   mastodon://guide            usage guide for agents (same as server instructions, longer)
 *   mastodon://docs             raw-markdown documentation URLs (machine readable)
 *   mastodon://catalog          every endpoint, one line each
 *   mastodon://catalog/{group}  one group
 *   mastodon://endpoint/{id}    full description of one endpoint
 */

export function guide(ctx: McpContext): string {
  const s = ctx.site;
  return `# Mastodon MCP — agent guide

Instance: ${ctx.scope.instance}  ·  MCP URL: ${s.base}${ctx.scope.prefix}/mcp  ·  auth: ${ctx.cred.kind}

## Workflow
1. mastodon_api_search {"query":"…"}  → endpoint ids (one line each, cheap)
2. mastodon_api_describe {"id":"…"}   → params, scopes, returns, raw docs URL
3. mastodon_api_call {"id":"…","args":{…}}  → result

Raw mode for anything not in the catalog: mastodon_api_call {"method":"GET","path":"/api/v1/…","query":{…}}.

## Saving tokens
- Responses are compact by default (HTML→text, nested accounts → {id,acct}, nulls dropped).
- Use "select":["id","content","account.acct"] to keep only what you need.
- Use "limit" (most lists accept up to 40, admin up to 100–200) and paging cursors (\`next\`) instead of big pages.
- Use "format":"full" only when you need raw fields (e.g. emojis, blurhash, avatar_static).

## Conventions
- IDs are strings. Accounts by handle: accounts.lookup {"acct":"user@domain"}. Remote posts/users by URL: search.v2 {"q":"https://…","resolve":true}.
- Paging: lists return {"next":{"max_id":"…"}}; pass those keys back in args. min_id pages forward.
- Nested params: {"poll":{"options":["a","b"],"expires_in":86400}}; arrays: {"media_ids":["1","2"]}.
- Files (media.v2 file, accounts.update_credentials avatar/header): {"url":"https://…"} or {"base64":"…","filename":"x.png","mime":"image/png"}.
- media.v2 returns 202 while processing; poll media.get until url is set before attaching to large videos.
- Idempotency: pass "idempotency_key" when posting statuses to avoid duplicates on retries.
- Visibility: public | unlisted | private (followers) | direct.
- Streaming (streaming.*): collects SSE events for up to 25 s; not a persistent subscription.
- Admin (admin.*) needs admin:* scopes AND a staff role. Moderation actions: admin.accounts.action {"id":…, "type":"none|sensitive|disable|silence|suspend", "text":"…"}.
- Errors include "hint" and the raw docs URL. 404 often means the instance's Mastodon version lacks the endpoint: check mastodon_auth → server.api_versions.

## Documentation (raw markdown, machine readable)
- Endpoint docs: ${DOCS_RAW_BASE}/methods/{group}.md   (admin: ${DOCS_RAW_BASE}/methods/admin/{name}.md)
- Entities: ${DOCS_RAW_BASE}/entities/{Entity}.md   (e.g. Status, Account, Admin_Account)
- Scopes: ${DOCS_RAW_BASE}/api/oauth-scopes.md · Paging/guidelines: ${DOCS_RAW_BASE}/api/guidelines.md · Rate limits: ${DOCS_RAW_BASE}/api/rate-limits.md
- This server: ${s.base}/llms.txt · ${s.base}/catalog.json (machine-readable catalog)
`;
}

export function docsIndex(): string {
  const files = [...new Set(ENDPOINTS.filter((e) => !e.undocumented).map((e) => e.doc.split("#")[0]))].sort();
  return [
    `# Mastodon API docs (raw markdown)`,
    `source: https://github.com/mastodon/documentation @ ${CATALOG_META.commit.slice(0, 12)} (catalog generated ${CATALOG_META.generated})`,
    ``,
    `## Methods`,
    ...files.map((f) => `${DOCS_RAW_BASE}/methods/${f}.md`),
    ``,
    `## Guides`,
    ...["api/guidelines", "api/oauth-scopes", "api/oauth-tokens", "api/rate-limits", "api/datetime-format", "client/authorized", "client/token", "spec/oauth", "entities/_index"].map((f) => `${DOCS_RAW_BASE}/${f}.md`),
    ``,
    `Entities: ${DOCS_RAW_BASE}/entities/{Name}.md (e.g. Status, Account, Notification, Admin_Report)`,
  ].join("\n");
}

export function listResources(ctx: McpContext) {
  const includeAdmin = !ctx.site.cfg.disableAdmin;
  return [
    { uri: "mastodon://guide", name: "guide", title: "Agent guide", mimeType: "text/markdown", description: "How to use this server efficiently." },
    { uri: "mastodon://docs", name: "docs", title: "Raw documentation URLs", mimeType: "text/plain", description: "Machine-readable Mastodon docs links." },
    { uri: "mastodon://catalog", name: "catalog", title: "All endpoints", mimeType: "text/plain", description: `${CATALOG_META.count} endpoints, one line each.` },
    ...groups(includeAdmin).map((g) => ({ uri: `mastodon://catalog/${g.group}`, name: `catalog/${g.group}`, mimeType: "text/plain", description: `${g.count} endpoints` })),
  ];
}

export const resourceTemplates = [
  { uriTemplate: "mastodon://endpoint/{id}", name: "endpoint", title: "Endpoint description", mimeType: "text/plain" },
  { uriTemplate: "mastodon://catalog/{group}", name: "catalog-group", title: "Endpoints in a group", mimeType: "text/plain" },
];

export function readResource(ctx: McpContext, uri: string): { uri: string; mimeType: string; text: string } | undefined {
  const includeAdmin = !ctx.site.cfg.disableAdmin;
  const ok = (text: string, mimeType = "text/plain") => ({ uri, mimeType, text });
  if (uri === "mastodon://guide") return ok(guide(ctx), "text/markdown");
  if (uri === "mastodon://docs") return ok(docsIndex());
  if (uri === "mastodon://catalog") return ok(ENDPOINTS.filter((e) => includeAdmin || !isAdmin(e)).map(endpointLine).join("\n"));
  const g = uri.match(/^mastodon:\/\/catalog\/(.+)$/);
  if (g) {
    const list = ENDPOINTS.filter((e) => (includeAdmin || !isAdmin(e)) && (e.group === g[1] || e.group.startsWith(g[1] + ".")));
    return list.length ? ok(list.map(endpointLine).join("\n")) : undefined;
  }
  const e = uri.match(/^mastodon:\/\/endpoint\/(.+)$/);
  if (e) {
    const ep = getEndpoint(decodeURIComponent(e[1]));
    if (!ep || (!includeAdmin && isAdmin(ep))) return undefined;
    return ok(`${describeEndpoint(ep, true)}\nweb: ${docUrls(ep).web}`);
  }
  return undefined;
}
