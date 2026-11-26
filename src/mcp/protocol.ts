/**
 * MCP JSON-RPC over Streamable HTTP. Dual-era and fully stateless:
 *
 * - Modern (2026-07-28): every request carries `_meta["io.modelcontextprotocol/protocolVersion"]`
 *   + `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers; `server/discover` is supported.
 * - Legacy (2025-03-26 … 2025-11-25): `initialize` handshake. We answer it but never mint
 *   `Mcp-Session-Id`, which those revisions allow (sessions are optional). Later requests
 *   carry `MCP-Protocol-Version` (or none for 2025-03-26).
 *
 * Spec: https://modelcontextprotocol.io/specification/2026-07-28
 */
import { ALL_VERSIONS, LEGACY_VERSIONS, MODERN_VERSIONS, SERVER_INFO } from "../version.ts";
import { HttpAuthChallenge, type McpContext } from "./context.ts";
import { PROMPTS } from "./prompts.ts";
import { listResources, readResource, resourceTemplates } from "./resources.ts";
import { callTool, listTools } from "./tools.ts";
import { CATALOG_META } from "../catalog/index.ts";

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPS = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER = "io.modelcontextprotocol/serverInfo";

export const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  HEADER_MISMATCH: -32020,
  UNSUPPORTED_VERSION: -32022,
} as const;

export interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcOutcome {
  status: number;
  body?: unknown;
}

const LIST_TTL_MS = 3_600_000;

const capabilities = { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false }, prompts: { listChanged: false } };

function instructions(ctx: McpContext): string {
  return `Mastodon API for ${ctx.scope.instance} (${CATALOG_META.count} endpoints incl. admin/moderation). Workflow: mastodon_api_search → mastodon_api_describe → mastodon_api_call. Raw calls: mastodon_api_call {method,path}. Keep output small with select/limit. Read mastodon://guide for conventions and raw docs URLs. Auth status: mastodon_auth.`;
}

const rpcError = (id: RpcRequest["id"], code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0",
  ...(id !== undefined && id !== null ? { id } : {}),
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

const decodeHeader = (v: string | null) => {
  if (v === null) return null;
  const m = v.match(/^=\?base64\?(.*)\?=$/);
  if (!m) return v;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)));
  } catch {
    return "\u0000invalid";
  }
};

/** Validate headers & version. Returns an error outcome, or the negotiated version. */
export function negotiate(msg: RpcRequest, headers: Headers): { version: string; modern: boolean } | RpcOutcome {
  const id = msg.id;
  const meta = (msg.params?._meta ?? {}) as Record<string, unknown>;
  const metaVersion = typeof meta[META_VERSION] === "string" ? (meta[META_VERSION] as string) : undefined;
  const headerVersion = headers.get("mcp-protocol-version");

  if (msg.method === "initialize") {
    const requested = String(msg.params?.protocolVersion ?? "");
    const version = (LEGACY_VERSIONS as readonly string[]).includes(requested) ? requested : LEGACY_VERSIONS[0];
    return { version, modern: false };
  }

  if (metaVersion) {
    if (!(MODERN_VERSIONS as readonly string[]).includes(metaVersion)) {
      return { status: 400, body: rpcError(id, ERR.UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: ALL_VERSIONS, requested: metaVersion }) };
    }
    if (headerVersion !== null && headerVersion !== metaVersion) {
      return { status: 400, body: rpcError(id, ERR.HEADER_MISMATCH, `Header mismatch: MCP-Protocol-Version '${headerVersion}' does not match _meta '${metaVersion}'`) };
    }
    if (headerVersion === null) return { status: 400, body: rpcError(id, ERR.HEADER_MISMATCH, "Missing MCP-Protocol-Version header") };
    const hMethod = headers.get("mcp-method");
    if (hMethod === null) return { status: 400, body: rpcError(id, ERR.HEADER_MISMATCH, "Missing Mcp-Method header") };
    if (hMethod !== msg.method) return { status: 400, body: rpcError(id, ERR.HEADER_MISMATCH, `Header mismatch: Mcp-Method '${hMethod}' does not match body '${msg.method}'`) };
    if (["tools/call", "resources/read", "prompts/get"].includes(msg.method)) {
      const bodyName = String(msg.params?.name ?? msg.params?.uri ?? "");
      const hName = decodeHeader(headers.get("mcp-name"));
      if (hName === null) return { status: 400, body: rpcError(id, ERR.HEADER_MISMATCH, "Missing Mcp-Name header") };
      if (hName !== bodyName) return { status: 400, body: rpcError(id, ERR.HEADER_MISMATCH, `Header mismatch: Mcp-Name does not match body`) };
    }
    if (typeof meta[META_CAPS] !== "object" || meta[META_CAPS] === null) {
      return { status: 400, body: rpcError(id, ERR.INVALID_PARAMS, `Missing required _meta field ${META_CAPS}`) };
    }
    return { version: metaVersion, modern: true };
  }

  // Legacy request (no _meta version).
  if (headerVersion !== null) {
    if (!(LEGACY_VERSIONS as readonly string[]).includes(headerVersion)) {
      if ((MODERN_VERSIONS as readonly string[]).includes(headerVersion)) {
        return { status: 400, body: rpcError(id, ERR.INVALID_PARAMS, `Missing required _meta field ${META_VERSION}`) };
      }
      return { status: 400, body: rpcError(id, ERR.UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: ALL_VERSIONS, requested: headerVersion }) };
    }
    return { version: headerVersion, modern: false };
  }
  // No header at all: treat as 2025-03-26 (allowed by spec for pre-2025-06-18 clients).
  return { version: "2025-03-26", modern: false };
}

/** Handle one JSON-RPC message. Throws HttpAuthChallenge to turn the response into 401/403. */
export async function handleRpc(ctx: McpContext, msg: RpcRequest, headers: Headers): Promise<RpcOutcome> {
  if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return { status: 400, body: rpcError(msg?.id ?? null, ERR.INVALID_REQUEST, "Invalid JSON-RPC request") };
  }
  const isNotification = msg.id === undefined || msg.id === null;
  if (isNotification) {
    // notifications/initialized, notifications/cancelled, etc.: accept and ignore.
    return { status: 202 };
  }

  const neg = negotiate(msg, headers);
  if ("status" in neg) return neg;
  const { version, modern } = neg;
  const id = msg.id!;
  const p = msg.params ?? {};

  const ok = (result: Record<string, unknown>) => {
    const r: Record<string, unknown> = { ...result };
    if (modern) {
      r.resultType = "complete";
      r._meta = { ...((r._meta as object) ?? {}), [META_SERVER]: SERVER_INFO };
    }
    return { status: 200, body: { jsonrpc: "2.0", id, result: r } };
  };
  const cacheable = (result: Record<string, unknown>, scope: "public" | "private" = "private") =>
    modern ? { ...result, ttlMs: LIST_TTL_MS, cacheScope: scope } : result;
  const fail = (code: number, message: string, status = 200, data?: unknown) => ({ status, body: rpcError(id, code, message, data) });

  switch (msg.method) {
    case "initialize":
      return ok({ protocolVersion: version, capabilities, serverInfo: SERVER_INFO, instructions: instructions(ctx) });

    case "server/discover":
      return ok({ supportedVersions: ALL_VERSIONS, capabilities, instructions: instructions(ctx), ttlMs: LIST_TTL_MS, cacheScope: "public" });

    case "ping":
      return ok({});

    case "tools/list":
      return ok(cacheable({ tools: listTools(ctx) }));

    case "tools/call": {
      const name = String(p.name ?? "");
      const args = (p.arguments ?? {}) as Record<string, unknown>;
      if (typeof args !== "object" || Array.isArray(args)) return fail(ERR.INVALID_PARAMS, "arguments must be an object", modern ? 400 : 200);
      try {
        const res = await callTool(ctx, name, args);
        if (!res) return fail(ERR.INVALID_PARAMS, `Unknown tool: ${name}`, modern ? 400 : 200);
        return ok(res as unknown as Record<string, unknown>);
      } catch (e) {
        if (e instanceof HttpAuthChallenge) throw e;
        return ok({ content: [{ type: "text", text: `internal error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
      }
    }

    case "resources/list":
      return ok(cacheable({ resources: listResources(ctx) }));

    case "resources/templates/list":
      return ok(cacheable({ resourceTemplates }, "public"));

    case "resources/read": {
      const uri = String(p.uri ?? "");
      const r = readResource(ctx, uri);
      if (!r) return fail(ERR.INVALID_PARAMS, `Resource not found: ${uri}`, modern ? 400 : 200);
      return ok(cacheable({ contents: [r] }));
    }

    case "prompts/list":
      return ok(cacheable({ prompts: PROMPTS.map(({ render: _r, ...x }) => x) }, "public"));

    case "prompts/get": {
      const pr = PROMPTS.find((x) => x.name === p.name);
      if (!pr) return fail(ERR.INVALID_PARAMS, `Unknown prompt: ${String(p.name)}`, modern ? 400 : 200);
      const text = pr.render((p.arguments ?? {}) as Record<string, string>);
      return ok({ description: pr.description, messages: [{ role: "user", content: { type: "text", text } }] });
    }

    case "completion/complete":
      return ok({ completion: { values: [], hasMore: false } });

    case "logging/setLevel":
      return ok({});

    default:
      return fail(ERR.METHOD_NOT_FOUND, `Method not found: ${msg.method}`, modern ? 404 : 200);
  }
}
