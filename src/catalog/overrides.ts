import type { Endpoint, Param } from "./types.ts";

/**
 * Hand-maintained additions and patches on top of the generated endpoints.json.
 *
 * - `extra`: endpoints that exist in Mastodon (config/routes/api.rb) but are not in
 *   the documentation repo. Mark them `undocumented: true`. Remove an entry once the
 *   docs cover it (`npm run check-routes` will tell you).
 * - `patches`: field-level fixes for generated entries, keyed by endpoint id. Use for
 *   docs bugs only, and prefer fixing the docs upstream.
 */

const id = (name = "id"): Param => ({ name, in: "path", type: "string", required: true });
const paging: Param[] = [
  { name: "max_id", in: "query", type: "string" },
  { name: "since_id", in: "query", type: "string" },
  { name: "min_id", in: "query", type: "string" },
  { name: "limit", in: "query", type: "int" },
];

function approvable(kind: "links" | "statuses" | "tags" | "links.publishers", path: string, entity: string): Endpoint[] {
  const group = "admin.trends";
  const base = { group, auth: "user" as const, params: [id()], undocumented: true, doc: "admin/trends" };
  return (["approve", "reject"] as const).map((action) => ({
    ...base,
    id: `admin.trends.${kind}-${action}`,
    method: "POST",
    path: `${path}/:id/${action}`,
    title: `${action === "approve" ? "Approve" : "Reject"} trending ${kind.replace("links.", "link ")}`,
    scopes: ["admin:write"],
    returns: entity,
  }));
}

export const extra: Endpoint[] = [
  ...approvable("links", "/api/v1/admin/trends/links", "PreviewCard"),
  ...approvable("statuses", "/api/v1/admin/trends/statuses", "Status"),
  ...approvable("tags", "/api/v1/admin/trends/tags", "Admin::Tag"),
  {
    id: "admin.trends.links.publishers",
    group: "admin.trends",
    method: "GET",
    path: "/api/v1/admin/trends/links/publishers",
    title: "List link publishers (preview card providers)",
    auth: "user",
    scopes: ["admin:read"],
    params: paging,
    undocumented: true,
    doc: "admin/trends",
  },
  ...approvable("links.publishers", "/api/v1/admin/trends/links/publishers", "PreviewCardProvider"),
  {
    id: "admin.tags.get",
    group: "admin.tags",
    method: "GET",
    path: "/api/v1/admin/tags",
    title: "List hashtags (admin)",
    auth: "user",
    scopes: ["admin:read"],
    params: paging,
    returns: "Array of Admin::Tag",
    undocumented: true,
    doc: "admin/trends",
  },
  {
    id: "admin.tags.get-one",
    group: "admin.tags",
    method: "GET",
    path: "/api/v1/admin/tags/:id",
    title: "View a hashtag (admin)",
    auth: "user",
    scopes: ["admin:read"],
    params: [id()],
    returns: "Admin::Tag",
    undocumented: true,
    doc: "admin/trends",
  },
  {
    id: "admin.tags.update",
    group: "admin.tags",
    method: "PUT",
    path: "/api/v1/admin/tags/:id",
    title: "Update a hashtag (admin)",
    auth: "user",
    scopes: ["admin:write"],
    params: [
      id(),
      { name: "display_name", in: "body", type: "string", desc: "Must case-insensitively match the tag name." },
      { name: "listable", in: "body", type: "bool", desc: "Allow in profile directory / explore." },
      { name: "trendable", in: "body", type: "bool", desc: "Allow to trend." },
      { name: "usable", in: "body", type: "bool", desc: "Allow use in posts." },
    ],
    returns: "Admin::Tag",
    undocumented: true,
    doc: "admin/trends",
  },
  {
    id: "domain_blocks.preview",
    group: "domain_blocks",
    method: "GET",
    path: "/api/v1/domain_blocks/preview",
    title: "Preview impact of blocking a domain",
    desc: "Counts of followers/following on the domain that a block would sever.",
    auth: "user",
    scopes: ["write:blocks"],
    params: [{ name: "domain", in: "query", type: "string", required: true }],
    undocumented: true,
    doc: "domain_blocks",
  },
  {
    id: "instance.languages",
    group: "instance",
    method: "GET",
    path: "/api/v1/instance/languages",
    title: "List supported languages",
    auth: "public",
    scopes: [],
    params: [],
    undocumented: true,
    doc: "instance",
  },
  {
    id: "peers.search",
    group: "instance",
    method: "GET",
    path: "/api/v1/peers/search",
    title: "Search known peer domains by prefix",
    auth: "optional",
    scopes: [],
    params: [{ name: "q", in: "query", type: "string", required: true, desc: "Domain prefix." }],
    undocumented: true,
    doc: "instance",
  },
  {
    id: "notifications.policy-v1",
    group: "notifications",
    method: "GET",
    path: "/api/v1/notifications/policy",
    title: "View notification filtering policy (v1)",
    auth: "user",
    scopes: ["read:notifications"],
    params: [],
    deprecated: true,
    returns: "V1::NotificationPolicy",
    entities: ["V1_NotificationPolicy"],
    undocumented: true,
    doc: "notifications#get-policy",
  },
  {
    id: "donation_campaigns.get",
    group: "donation_campaigns",
    method: "GET",
    path: "/api/v1/donation_campaigns",
    title: "Get current donation campaign",
    desc: "204 when none is configured.",
    auth: "user",
    scopes: [],
    params: [],
    undocumented: true,
    doc: "instance",
  },
  {
    id: "accounts.email_subscriptions",
    group: "accounts",
    method: "POST",
    path: "/api/v1/accounts/:account_id/email_subscriptions",
    title: "Subscribe an email address to a local account's posts",
    auth: "public",
    scopes: [],
    params: [id("account_id"), { name: "email", in: "body", type: "string", required: true }],
    undocumented: true,
    doc: "accounts",
  },
];

export const patches: Record<string, Partial<Endpoint>> = {};

/**
 * Old id -> current id. Ids are a public interface (agents remember them); when a docs
 * anchor changes, add the previous id here instead of breaking callers.
 */
export const aliases: Record<string, string> = {};
