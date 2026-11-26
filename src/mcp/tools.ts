/**
 * MCP tool surface.
 *
 * Token efficiency: by default `tools/list` returns a handful of meta-tools (~1.5k tokens)
 * instead of 270 endpoint tools (~60k+). Agents discover endpoints with
 * `mastodon_api_search`, read params with `mastodon_api_describe`, and call with
 * `mastodon_api_call`. Clients that prefer direct tools can add `?expose=statuses,timelines`
 * (or `?expose=all`) to the MCP URL to also get one tool per endpoint in those groups.
 */
import {
  CATALOG_META,
  describeParams,
  docUrls,
  ENDPOINTS,
  entityRawUrl,
  getEndpoint,
  groups,
  isAdmin,
  paramsSchema,
  search,
  type Endpoint,
} from "../catalog/index.ts";
import { DOCS_RAW_BASE } from "../version.ts";
import type { McpContext } from "./context.ts";
import { executeEndpoint, executeRaw, text, type CallOptions, type ToolResult } from "./execute.ts";

export interface ToolDef {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean | string>;
}

interface Tool extends ToolDef {
  handler(ctx: McpContext, args: Record<string, unknown>): Promise<ToolResult>;
}

const OUTPUT_PROPS = {
  format: { type: "string", enum: ["compact", "full"], description: "compact (default): HTML→text, nested accounts shrunk, nulls dropped. full: raw JSON." },
  select: { type: "array", items: { type: "string" }, description: 'Keep only these dot-paths, e.g. ["id","account.acct","content"].' },
  pages: { type: "integer", minimum: 1, maximum: 10, description: "GET lists: follow Link 'next' up to N pages." },
};

function outputOpts(a: Record<string, unknown>): CallOptions {
  return {
    format: a.format === "full" ? "full" : "compact",
    select: Array.isArray(a.select) ? a.select.map(String) : undefined,
    pages: typeof a.pages === "number" ? a.pages : undefined,
    seconds: typeof a.seconds === "number" ? a.seconds : undefined,
    max_events: typeof a.max_events === "number" ? a.max_events : undefined,
  };
}

const visible = (ctx: McpContext, ep: Endpoint) => !(ctx.site.cfg.disableAdmin && isAdmin(ep));

/** One compact line per endpoint: `id  METHOD /path  — title [auth:scope] (flags)` */
function line(ep: Endpoint): string {
  const auth = ep.auth === "public" ? "public" : ep.auth === "optional" ? `optional${ep.scopes[0] ? ":" + ep.scopes[0] : ""}` : `${ep.auth}${ep.scopes.length ? ":" + ep.scopes.join("|") : ""}`;
  const flags = [ep.deprecated && "deprecated", ep.kind && ep.kind !== "rest" && ep.kind, ep.undocumented && "undocumented"].filter(Boolean).join(",");
  return `${ep.id}  ${ep.method} ${ep.path}  — ${ep.title} [${auth}]${flags ? ` (${flags})` : ""}`;
}

function describe(ep: Endpoint, schema: boolean): string {
  const urls = docUrls(ep);
  const out: string[] = [line(ep)];
  if (ep.desc && ep.desc !== ep.title) out.push(ep.desc);
  if (ep.authNote) out.push(`auth: ${ep.authNote}`);
  if (ep.returns) out.push(`returns: ${ep.returns}${ep.entities?.length ? `  (${ep.entities.map(entityRawUrl).join(" ")})` : ""}`);
  const ver = [ep.since && `since ${ep.since}`, ep.apiVersion && `api_versions.mastodon>=${ep.apiVersion}`].filter(Boolean).join(", ");
  if (ver) out.push(`version: ${ver}`);
  if (ep.params.length) {
    out.push("params (nested JSON or flat bracket names both accepted):");
    out.push(...describeParams(ep));
  } else out.push("params: none");
  if (ep.params.some((p) => p.file)) out.push('files: pass {"url":"https://…"} | {"base64":"…","filename":"a.png","mime":"image/png"} | "data:image/png;base64,…"');
  if (ep.kind === "stream") out.push("streaming: mastodon_api_call collects events for `seconds` (≤25) / `max_events`.");
  if (ep.params.some((p) => p.name === "max_id")) out.push("paging: response `next`/`prev` hold cursors; pass them back as args, or use `pages`.");
  out.push(`doc: ${urls.raw}${urls.anchor ? " #" + urls.anchor : ""}`);
  if (schema) out.push("schema: " + JSON.stringify(paramsSchema(ep.params, { includeHeaders: true })));
  return out.join("\n");
}

const META_TOOLS: Tool[] = [
  {
    name: "mastodon_api_search",
    title: "Search Mastodon API endpoints",
    description:
      "Find Mastodon API endpoints by keywords (e.g. 'post status', 'home timeline', 'suspend account'). Returns one line per match: id, method, path, title, [auth:scopes]. Empty query + group lists that group. Then use mastodon_api_describe or mastodon_api_call with the id.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords. Synonyms like toot/boost/like/dm/ban are understood." },
        group: { type: "string", description: "Restrict to a group (e.g. statuses, timelines, admin, admin.accounts). Omit query to list it." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 12." },
        include_deprecated: { type: "boolean" },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async handler(ctx, a) {
      const includeAdmin = !ctx.site.cfg.disableAdmin;
      const q = String(a.query ?? "");
      const g = a.group ? String(a.group) : undefined;
      if (!q && !g) {
        const gs = groups(includeAdmin).map((x) => `${x.group}(${x.count})`).join(" ");
        return text(`${CATALOG_META.count} endpoints. Groups: ${gs}\nUse {"group":"…"} to list one, or {"query":"…"}.`);
      }
      const res = search(q, { group: g, includeAdmin, includeDeprecated: !!a.include_deprecated, limit: Number(a.limit) || (q ? 12 : 100) });
      if (!res.length) return text(`No endpoints match. Try other words, or {"group":"…"}; list groups with {}.`);
      return text(res.map(line).join("\n"));
    },
  },
  {
    name: "mastodon_api_describe",
    title: "Describe a Mastodon API endpoint",
    description: "Parameters, auth/scopes, return entity, version and raw docs URL for one or more endpoint ids. Set schema=true for full JSON Schema.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Endpoint id from mastodon_api_search, e.g. statuses.create" },
        ids: { type: "array", items: { type: "string" }, maxItems: 10 },
        schema: { type: "boolean", description: "Also include JSON Schema for arguments." },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async handler(ctx, a) {
      const ids = [...(a.id ? [String(a.id)] : []), ...(Array.isArray(a.ids) ? a.ids.map(String) : [])];
      if (!ids.length) return text("Provide id or ids.", true);
      const out = ids.map((id) => {
        const ep = getEndpoint(id);
        if (!ep || !visible(ctx, ep)) {
          const near = search(id.replace(/[._-]/g, " "), { includeAdmin: !ctx.site.cfg.disableAdmin, limit: 3 }).map((e) => e.id);
          return `${id}: unknown id.${near.length ? " Did you mean: " + near.join(", ") : ""}`;
        }
        return describe(ep, !!a.schema);
      });
      return text(out.join("\n\n"));
    },
  },
  {
    name: "mastodon_api_call",
    title: "Call a Mastodon API endpoint",
    description:
      'Call any Mastodon REST endpoint on this instance. Either {id, args} for a catalog endpoint (path params go in args), or {method, path, query?, body?} for raw access (new/undocumented endpoints). args accept nested JSON ({"poll":{"options":["a","b"],"expires_in":3600}}) or docs bracket names ({"media_ids[]":["1"]}). Responses are compacted by default; lists include `next` cursors.',
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Endpoint id, e.g. timelines.home, statuses.create, admin.accounts.action" },
        args: { type: "object", description: "Path, query and body params for id-mode." },
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "Raw mode." },
        path: { type: "string", description: "Raw mode, e.g. /api/v1/accounts/123/statuses" },
        query: { type: "object", description: "Raw mode query params." },
        body: { type: "object", description: "Raw mode JSON body (or multipart if `files` given)." },
        files: { type: "array", items: { type: "string" }, description: "Raw mode: body keys that are file inputs." },
        idempotency_key: { type: "string", description: "Sent as Idempotency-Key (status creation)." },
        seconds: { type: "integer", minimum: 1, maximum: 25, description: "Streaming endpoints: listen duration (default 10)." },
        max_events: { type: "integer", minimum: 1, maximum: 200, description: "Streaming endpoints: stop after N events (default 20)." },
        ...OUTPUT_PROPS,
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async handler(ctx, a) {
      const opts = outputOpts(a);
      const headers: Record<string, string> = {};
      if (a.idempotency_key) headers["Idempotency-Key"] = String(a.idempotency_key);
      if (a.id) {
        const ep = getEndpoint(String(a.id));
        if (!ep || !visible(ctx, ep)) {
          const near = search(String(a.id).replace(/[._-]/g, " "), { includeAdmin: !ctx.site.cfg.disableAdmin, limit: 3 }).map((e) => e.id);
          return text(`Unknown endpoint id "${a.id}".${near.length ? " Did you mean: " + near.join(", ") : ""}`, true);
        }
        const args = { ...((a.args as Record<string, unknown>) ?? {}) };
        if (headers["Idempotency-Key"]) args["Idempotency-Key"] = headers["Idempotency-Key"];
        return executeEndpoint(ctx, ep, args, opts);
      }
      if (a.method && a.path) {
        return executeRaw(
          ctx,
          String(a.method),
          String(a.path),
          { query: a.query as Record<string, unknown>, body: a.body as Record<string, unknown>, headers, files: Array.isArray(a.files) ? a.files.map(String) : undefined },
          opts,
        );
      }
      return text("Provide {id, args} or {method, path}. Find ids with mastodon_api_search.", true);
    },
  },
  {
    name: "mastodon_auth",
    title: "Authentication status",
    description: "Who am I on this instance, how this session is authenticated, granted scopes, and how to (re)authenticate. Also returns instance/API version info.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    async handler(ctx) {
      const { cred, scope, site } = ctx;
      const info: Record<string, unknown> = {
        instance: scope.instance,
        mcp_url: `${site.base}${scope.prefix}/mcp`,
        auth: cred.kind,
      };
      if (cred.scopes) info.scopes = cred.scopes.join(" ");
      if (cred.token) {
        const me = await executeEndpoint(ctx, getEndpoint("accounts.verify_credentials")!, {}, { select: ["id", "acct", "display_name", "url", "role.name", "role.permissions"] });
        info.account = me.isError ? me.content[0].text : JSON.parse(me.content[0].text);
      } else {
        info.note = "anonymous: only public endpoints work.";
      }
      const inst = await executeEndpoint(ctx, getEndpoint("instance.v2")!, {}, { select: ["version", "api_versions", "title"] });
      if (!inst.isError) info.server = JSON.parse(inst.content[0].text);
      info.how_to_auth = {
        oauth: site.cfg.secretKey ? "Supported: MCP clients discover it via 401 + /.well-known/oauth-protected-resource." : "Disabled (server has no SECRET_KEY).",
        bearer: site.cfg.allowPassthrough ? "Authorization: Bearer <Mastodon access token> (or X-Mastodon-Token header)." : "Disabled.",
        admin: "Admin endpoints need admin:read / admin:write scopes AND a staff role on the account.",
      };
      info.docs = { llms_txt: `${site.base}/llms.txt`, catalog: `${site.base}/catalog.json`, raw_docs: DOCS_RAW_BASE };
      return text(JSON.stringify(info));
    },
  },
];

// ---------- per-endpoint tools (opt-in via ?expose=) ----------

export const toolNameFor = (ep: Endpoint) => `m_${ep.id.replace(/[^A-Za-z0-9_]+/g, "_")}`.slice(0, 128);
const BY_TOOL_NAME = new Map(ENDPOINTS.map((ep) => [toolNameFor(ep), ep]));

function endpointTool(ep: Endpoint): ToolDef {
  const schema = paramsSchema(ep.params, { includeHeaders: true });
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  if (ep.method === "GET") Object.assign(props, OUTPUT_PROPS);
  else Object.assign(props, { format: OUTPUT_PROPS.format, select: OUTPUT_PROPS.select });
  const readOnly = ep.method === "GET";
  return {
    name: toolNameFor(ep),
    title: ep.title,
    description: `${ep.method} ${ep.path} — ${ep.desc ?? ep.title}${ep.scopes.length ? ` [${ep.auth}:${ep.scopes.join("|")}]` : ` [${ep.auth}]`}`.slice(0, 300),
    inputSchema: { ...schema, properties: props },
    annotations: { readOnlyHint: readOnly, destructiveHint: ep.method === "DELETE" || /suspend|delete|reject|block|action/.test(ep.id), idempotentHint: readOnly || ep.method === "PUT" || ep.method === "DELETE", openWorldHint: true },
  };
}

function exposedEndpoints(ctx: McpContext): Endpoint[] {
  if (!ctx.expose.length) return [];
  const all = ctx.expose.includes("all");
  return ENDPOINTS.filter((ep) => visible(ctx, ep) && ep.kind !== "websocket" && ep.kind !== "browser" && !ep.deprecated && (all || ctx.expose.some((g) => ep.group === g || ep.group.startsWith(g + "."))));
}

export function listTools(ctx: McpContext): ToolDef[] {
  const meta = META_TOOLS.map(({ handler: _h, ...def }) => def);
  return [...meta, ...exposedEndpoints(ctx).map(endpointTool)];
}

export async function callTool(ctx: McpContext, name: string, args: Record<string, unknown>): Promise<ToolResult | undefined> {
  const meta = META_TOOLS.find((t) => t.name === name);
  if (meta) return meta.handler(ctx, args);
  const ep = BY_TOOL_NAME.get(name);
  if (ep && exposedEndpoints(ctx).includes(ep)) {
    const { format, select, pages, ...rest } = args;
    return executeEndpoint(ctx, ep, rest, outputOpts({ format, select, pages }));
  }
  return undefined;
}

export { describe as describeEndpoint, line as endpointLine };
