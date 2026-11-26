/**
 * Drift report: compares the catalog with Mastodon's actual API routes and OAuth scopes.
 *
 *   MASTODON_DIR=/tmp/mastodon npm run check-routes
 *
 * Uses `bin/rails routes` output if ROUTES_FILE is given (most accurate), otherwise a
 * heuristic parse of controllers under app/controllers/api. Output is advisory: review
 * each "missing" entry and add it to src/catalog/overrides.ts (or fix the docs upstream).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { ENDPOINTS } from "../src/catalog/index.ts";
import { KNOWN_SCOPES } from "../src/auth/scopes.ts";

const DIR = process.env.MASTODON_DIR ?? "/tmp/mastodon";
if (!existsSync(join(DIR, "config/routes/api.rb"))) {
  console.error(`Mastodon repo not found at ${DIR}. git clone --depth 1 https://github.com/mastodon/mastodon.git ${DIR}`);
  process.exit(1);
}

const norm = (p: string) => p.replace(/:[a-z_]+/g, ":x").replace(/\(\.:format\)$/, "").replace(/\/$/, "");
const catalog = new Set(ENDPOINTS.map((e) => `${e.method} ${norm(e.path)}`));

let routes: string[] = [];
if (process.env.ROUTES_FILE) {
  // Format of `bin/rails routes`: "  name VERB /path(.:format) controller#action"
  for (const line of readFileSync(process.env.ROUTES_FILE, "utf8").split("\n")) {
    const m = line.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/(?:api|oauth)\S*)/);
    if (m) routes.push(`${m[1]} ${norm(m[2])}`);
  }
} else {
  // Heuristic: controller file path -> resource path; actions -> verbs.
  const base = join(DIR, "app/controllers/api");
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith("_controller.rb") ? [join(d, e.name)] : []));
  const ACTIONS: Record<string, string> = { index: "GET", show: "GET", create: "POST", update: "PUT", destroy: "DELETE" };
  for (const f of walk(base)) {
    const rel = relative(base, f).replace(/_controller\.rb$/, "");
    if (!/^v\d/.test(rel) || rel.endsWith("/base")) continue;
    const src = readFileSync(f, "utf8");
    const actions = [...src.matchAll(/^\s+def (\w+)$/gm)].map((m) => m[1]).filter((a) => a in ACTIONS);
    if (!actions.length) continue;
    // Controller names that routes.rb maps to different URL segments.
    const RENAME: Record<string, string> = {
      instances: "instance", histories: "history", policies: "policy", translations: "translate",
      account_actions: "action", preview_card_providers: "publishers", collection_items: "items",
      directories: "directory", privacy_policies: "privacy_policy", extended_descriptions: "extended_description",
      interaction_policies: "interaction_policy",
    };
    // Served outside /api (GET /invite/:code.json); not an API endpoint.
    if (rel === "v1/invites") continue;
    const segs = rel.split("/").map((s) => RENAME[s] ?? s);
    const resource = segs.pop()!;
    const prefix = `/api/${segs.join("/")}`;
    const needle = resource.replace(/_accounts$/, "").replace(/s$/, "");
    const hits = ENDPOINTS.filter((e) => e.path.startsWith(prefix) && e.path.includes(needle));
    if (!hits.length) routes.push(`?   ${prefix}/${resource}  (${actions.join(",")})  ${relative(DIR, f)}`);
  }
}

let missing = 0;
if (process.env.ROUTES_FILE) {
  for (const r of [...new Set(routes)].sort()) {
    if (!catalog.has(r) && !/\/(web|fasp)\//.test(r) && !r.includes("/streaming")) {
      console.log(`missing  ${r}`);
      missing++;
    }
  }
  const routeSet = new Set(routes);
  for (const e of ENDPOINTS) {
    const k = `${e.method} ${norm(e.path)}`;
    if (!routeSet.has(k) && e.path.startsWith("/api") && !e.path.includes("/streaming")) console.log(`stale?   ${k}  (${e.id})`);
  }
} else {
  for (const r of routes) {
    console.log(`unmatched controller ${r}`);
    missing++;
  }
}

// Scope drift vs doorkeeper.rb
const dk = readFileSync(join(DIR, "config/initializers/doorkeeper.rb"), "utf8");
const scopes = [...dk.matchAll(/:'?([a-z:_]+)'?,?$/gm)].map((m) => m[1]).filter((s) => /^(read|write|admin|follow|push|profile)/.test(s));
for (const s of scopes) if (!KNOWN_SCOPES.includes(s)) console.log(`scope    ${s} missing from src/auth/scopes.ts KNOWN_SCOPES`);
for (const s of KNOWN_SCOPES) if (!scopes.includes(s)) console.log(`scope    ${s} in KNOWN_SCOPES but not in doorkeeper.rb`);

console.log(`\n${missing} potential gaps (heuristic=${!process.env.ROUTES_FILE}). Add real gaps to src/catalog/overrides.ts.`);
