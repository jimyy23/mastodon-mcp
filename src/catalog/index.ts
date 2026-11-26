import data from "./endpoints.json";
import { aliases, extra, patches } from "./overrides.ts";
import type { CatalogFile, Endpoint, Param } from "./types.ts";
import { DOCS_RAW_BASE, DOCS_WEB_BASE } from "../version.ts";

export type { Endpoint, Param } from "./types.ts";

const file = data as unknown as CatalogFile;

function build(): Endpoint[] {
  const byId = new Map<string, Endpoint>();
  for (const ep of file.endpoints) byId.set(ep.id, { ...ep, ...(patches[ep.id] ?? {}) });
  for (const ep of extra) {
    if (byId.has(ep.id)) throw new Error(`override id collides with generated endpoint: ${ep.id}`);
    byId.set(ep.id, ep);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export const ENDPOINTS: Endpoint[] = build();
export const CATALOG_META = { source: file.source, commit: file.commit, generated: file.generated, count: ENDPOINTS.length };
const BY_ID = new Map(ENDPOINTS.map((e) => [e.id, e]));

export const isAdmin = (ep: Endpoint) => ep.group === "admin" || ep.group.startsWith("admin.");

export function getEndpoint(id: string): Endpoint | undefined {
  return BY_ID.get(id) ?? BY_ID.get(aliases[id] ?? "");
}

/** Find a catalog entry matching a concrete method + path (e.g. for raw calls). */
export function matchPath(method: string, path: string): { ep: Endpoint; pathParams: Record<string, string> } | undefined {
  const m = method.toUpperCase();
  for (const ep of ENDPOINTS) {
    if (ep.method !== m) continue;
    const names: string[] = [];
    const re = new RegExp(
      "^" + ep.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:([a-z_]+)/g, (_, n) => (names.push(n), "([^/]+)")) + "$",
    );
    const hit = path.match(re);
    if (hit) return { ep, pathParams: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(hit[i + 1])])) };
  }
  return undefined;
}

export function groups(includeAdmin: boolean): { group: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const ep of ENDPOINTS) {
    if (!includeAdmin && isAdmin(ep)) continue;
    counts.set(ep.group, (counts.get(ep.group) ?? 0) + 1);
  }
  return [...counts.entries()].map(([group, count]) => ({ group, count }));
}

// ---------- search ----------

const SYNONYMS: Record<string, string[]> = {
  post: ["status", "statuses", "create"],
  toot: ["status", "statuses"],
  tweet: ["status", "statuses"],
  boost: ["reblog", "boost"],
  retoot: ["reblog"],
  like: ["favourite"],
  fav: ["favourite"],
  favorite: ["favourite"],
  favorites: ["favourites"],
  dm: ["direct", "conversation"],
  message: ["conversation", "direct"],
  user: ["account"],
  users: ["accounts"],
  profile: ["account", "credentials", "profile"],
  me: ["verify_credentials", "credentials"],
  whoami: ["verify_credentials"],
  i: ["verify_credentials"],
  members: ["accounts"],
  member: ["accounts"],
  feed: ["timeline"],
  home: ["timeline", "home"],
  ban: ["suspend", "action", "admin"],
  suspend: ["action", "suspend"],
  silence: ["action", "silence", "limit"],
  moderate: ["admin", "report", "action"],
  moderation: ["admin", "report"],
  upload: ["media"],
  image: ["media"],
  picture: ["media"],
  video: ["media"],
  hashtag: ["tag", "tags"],
  hashtags: ["tags"],
  unfollow: ["unfollow"],
  delete: ["delete", "remove"],
  remove: ["delete", "remove"],
  edit: ["edit", "update"],
  update: ["update", "edit"],
  schedule: ["scheduled"],
  draft: ["scheduled"],
  emoji: ["custom_emojis", "emoji"],
  thread: ["context"],
  replies: ["context"],
  stream: ["streaming"],
  realtime: ["streaming"],
  token: ["oauth", "token"],
  login: ["oauth", "authorize"],
  signup: ["oauth", "authorize"],
  register: ["apps", "create"],
  server: ["instance"],
  rules: ["instance", "rules"],
};

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9_:]+/)
    .filter((t) => t.length > 1);
}

const INDEX = ENDPOINTS.map((ep) => ({
  ep,
  id: ep.id.toLowerCase(),
  title: ep.title.toLowerCase(),
  path: ep.path.toLowerCase(),
  rest: `${ep.desc ?? ""} ${ep.returns ?? ""} ${ep.scopes.join(" ")}`.toLowerCase(),
}));

const STOP = new Set(["the", "an", "of", "to", "for", "in", "on", "my", "with", "and", "or", "by", "from", "get", "view", "show", "all", "is", "it", "this", "that", "am", "who", "what", "how", "do"]);
const WRITE_VERBS = /\b(post|create|publish|send|write|toot|add|new|make|compose)\b/;
const ADMIN_WORDS = /\b(admin|moderat\w*|ban|suspend|silence|sensitive|approve|reject|report|reports|domain_block|ip|canonical|email_domain|measures|dimensions|retention|staff|trends? review)\b/;

/** Whole-phrase shortcuts for common intents that keyword matching ranks poorly. */
const PHRASES: [RegExp, string][] = [
  [/\b(who ?am ?i|whoami|my (account|profile)|current user|verify credentials)\b/, "accounts.verify_credentials"],
  [/\bmy notifications\b|\bnotifications?\b$/, "grouped_notifications.get-grouped"],
  [/\b(server|instance) (info|information|version)\b/, "instance.v2"],
];

export function search(query: string, opts: { group?: string; includeAdmin: boolean; includeDeprecated?: boolean; limit?: number }): Endpoint[] {
  const lower = query.toLowerCase().trim();
  const boosted = new Set(PHRASES.filter(([re]) => re.test(lower)).map(([, id]) => id));
  const all = tokens(query);
  const q = all.filter((t) => !STOP.has(t));
  if (!q.length) q.push(...all);
  const groupFilter = opts.group?.toLowerCase();
  const adminIntent = ADMIN_WORDS.test(query.toLowerCase()) || !!groupFilter?.startsWith("admin");
  const writeIntent = WRITE_VERBS.test(query.toLowerCase());
  const results: { ep: Endpoint; score: number }[] = [];
  for (const row of INDEX) {
    const { ep } = row;
    if (!opts.includeAdmin && isAdmin(ep)) continue;
    if (groupFilter && !(ep.group === groupFilter || ep.group.startsWith(groupFilter + "."))) continue;
    let score = 0;
    let matched = 0;
    for (const t of q) {
      const alts = [t, ...(SYNONYMS[t] ?? [])];
      let best = 0;
      for (const a of alts) {
        const w = a === t ? 1 : 0.6;
        // Very short words only count as whole id segments, not substrings.
        if (a.length < 3) {
          if (row.id.split(/[._-]/).includes(a)) best = Math.max(best, 3 * w);
          continue;
        }
        if (row.id === a || row.id.endsWith("." + a)) best = Math.max(best, 6 * w);
        else if (row.id.includes(a)) best = Math.max(best, 4 * w);
        if (row.title.includes(a)) best = Math.max(best, 3 * w);
        if (row.path.includes(a)) best = Math.max(best, 2.5 * w);
        if (row.rest.includes(a)) best = Math.max(best, 1 * w);
      }
      score += best;
      if (best > 0) matched++;
    }
    if (!q.length) score = 1;
    if (boosted.has(ep.id)) score += 20;
    if (score <= 0) continue;
    // Reward endpoints matching more distinct query words.
    if (q.length > 1) score += (matched / q.length) * 4;
    if (isAdmin(ep) && !adminIntent) score -= 3;
    if (writeIntent && ep.method === "POST") score += 1.5;
    if (ep.deprecated) score -= opts.includeDeprecated ? 0.5 : 3;
    if (ep.kind === "websocket") score -= 2;
    if (score > 0) results.push({ ep, score });
  }
  results.sort((a, b) => b.score - a.score || a.ep.id.localeCompare(b.ep.id));
  return results.slice(0, opts.limit ?? 15).map((r) => r.ep);
}

// ---------- docs URLs ----------

export function docUrls(ep: Endpoint) {
  const [file, anchor] = ep.doc.split("#");
  return {
    raw: `${DOCS_RAW_BASE}/methods/${file}.md`,
    web: `${DOCS_WEB_BASE}/methods/${file}/${anchor ? "#" + anchor : ""}`,
    anchor,
  };
}

export const entityRawUrl = (name: string) => `${DOCS_RAW_BASE}/entities/${name}.md`;

// ---------- schema ----------

/** Split `poll[options][]` into ["poll", "options", "[]"]; `:index` segments become "[]" (array of objects). */
export function splitName(name: string): string[] {
  const m = name.match(/^([^[]+)(.*)$/);
  if (!m) return [name];
  const parts = [m[1]];
  for (const seg of m[2].matchAll(/\[([^\]]*)\]/g)) {
    const s = seg[1];
    parts.push(s === "" || s.startsWith(":") ? "[]" : s);
  }
  return parts;
}

type Schema = Record<string, unknown> & {
  type?: string | string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  required?: string[];
};

function leafSchema(p: Param): Schema {
  const s: Schema = {};
  switch (p.type) {
    case "int":
      s.type = "integer";
      break;
    case "number":
      s.type = "number";
      break;
    case "bool":
      s.type = "boolean";
      break;
    case "object":
      s.type = "object";
      break;
    case "file":
      s.description = "File: {url} | {base64, filename?, mime?} | data: URI";
      s.type = ["object", "string"];
      break;
    case "int[]":
      s.type = "array";
      s.items = { type: "integer" };
      break;
    case "string[]":
      s.type = "array";
      s.items = { type: "string" };
      break;
    case "object[]":
      s.type = "array";
      s.items = { type: "object" };
      break;
    case "string|string[]":
      s.type = ["string", "array"];
      break;
    default:
      s.type = "string";
  }
  if (p.enum) {
    if (s.type === "array") (s.items as Schema).enum = p.enum;
    else s.enum = p.enum;
  }
  if (p.desc && p.type !== "file") s.description = p.desc;
  return s;
}

/**
 * Convert flat docs params into a nested JSON Schema (object). Bracket names become
 * nested objects/arrays, matching what Rails accepts as a JSON body:
 *   poll[options][] -> { poll: { options: string[] } }
 *   keywords_attributes[][keyword] -> { keywords_attributes: [{ keyword }] }
 */
export function paramsSchema(params: Param[], opts: { includeHeaders?: boolean } = {}): Schema {
  const root: Schema = { type: "object", properties: {} };
  const requiredTop = new Set<string>();
  for (const p of params) {
    if (p.in === "header" && !opts.includeHeaders) continue;
    const parts = splitName(p.name);
    if (p.required && parts.length === 1) requiredTop.add(parts[0]);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const last = i === parts.length - 1;
      const nextIsArray = parts[i + 1] === "[]";
      if (part === "[]") continue;
      node.properties ??= {};
      const existing = node.properties[part];
      if (last || (nextIsArray && i + 1 === parts.length - 1)) {
        // leaf (possibly `name[]` array leaf); never clobber a container built by a sibling param
        if (!existing) node.properties[part] = leafSchema(p);
        break;
      }
      if (nextIsArray) {
        // array of objects: name[][child] / name[:index][child]
        const desc = existing?.description;
        if (!existing || existing.type !== "array" || !(existing.items as Schema)?.properties) {
          node.properties[part] = { type: "array", items: { type: "object", properties: {} }, ...(desc ? { description: desc } : {}) };
        }
        node = node.properties[part].items as Schema;
      } else {
        if (!existing || existing.type !== "object" || !existing.properties) {
          node.properties[part] = { type: "object", properties: {}, ...(existing?.description ? { description: existing.description } : {}) };
        }
        node = node.properties[part];
      }
    }
  }
  if (requiredTop.size) root.required = [...requiredTop];
  return root;
}

/** One-line-per-param, human/LLM-friendly description. Cheaper than JSON Schema. */
export function describeParams(ep: Endpoint): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const p of ep.params) {
    const parts = splitName(p.name);
    const top = parts[0];
    const display = parts.length === 1 ? top : `${top}${parts.slice(1).map((x) => (x === "[]" ? "[]" : "." + x)).join("")}`;
    if (seen.has(display)) continue;
    seen.add(display);
    const flags = [p.in === "path" ? "path" : p.in === "header" ? "header" : "", p.required ? "required" : ""].filter(Boolean).join(",");
    const enumPart = p.enum ? ` (${p.enum.join("|")})` : "";
    lines.push(`  ${display}: ${p.type}${enumPart}${flags ? ` [${flags}]` : ""}${p.desc ? " — " + p.desc : ""}`);
  }
  return lines;
}
