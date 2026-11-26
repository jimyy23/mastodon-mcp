import { vi } from "vitest";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { MemoryStore } from "../src/store.ts";

export interface UpstreamCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: UpstreamCall) => Response | Promise<Response> | undefined;

export const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });

/** Replace global fetch with a fake Mastodon. Unmatched requests get 404. */
export function mockUpstream(handler: Handler) {
  const calls: UpstreamCall[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    let body: unknown = init.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {}
    } else if (body instanceof URLSearchParams) body = Object.fromEntries(body);
    else if (body instanceof FormData) {
      const o: Record<string, unknown> = {};
      body.forEach((v, k) => (o[k] = v));
      body = o;
    }
    const call = { method: (init.method ?? "GET").toUpperCase(), url, headers, body };
    calls.push(call);
    return (await handler(call)) ?? json({ error: "not found" }, { status: 404 });
  });
  return calls;
}

export function makeApp(env: Record<string, string> = {}) {
  const store = new MemoryStore();
  const app = createApp({ cfg: loadConfig({ SECRET_KEY: "test-secret", ...env }), store });
  return { app, store };
}

const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };

/** Send a modern (2026-07-28) MCP request with correct headers. */
export async function rpc(
  app: ReturnType<typeof createApp>,
  method: string,
  params: Record<string, unknown> = {},
  opts: { path?: string; auth?: string; headers?: Record<string, string>; id?: number } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
    ...(opts.headers ?? {}),
  };
  const name = params.name ?? params.uri;
  if (name && !("mcp-name" in headers)) headers["mcp-name"] = String(name);
  if (opts.auth) headers.authorization = opts.auth;
  const res = await app.request(`http://mcp.test${opts.path ?? "/mastodon.example/mcp"}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: opts.id ?? 1, method, params: { ...params, _meta: META } }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
}

/** Call a tool and return its text (and isError). */
export async function callTool(app: ReturnType<typeof createApp>, name: string, args: Record<string, unknown>, opts: Parameters<typeof rpc>[3] = {}) {
  const r = await rpc(app, "tools/call", { name, arguments: args }, { auth: "Bearer mastotoken", ...opts });
  if (r.status !== 200) return { status: r.status, text: JSON.stringify(r.body), isError: true, raw: r };
  const result = r.body.result;
  return { status: r.status, text: result.content[0].text as string, isError: !!result.isError, raw: r };
}
