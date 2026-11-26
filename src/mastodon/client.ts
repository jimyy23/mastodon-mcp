import type { Config } from "../config.ts";
import { instanceBaseUrl, normalizeInstance } from "../instance.ts";
import { b64urlDecode } from "../auth/crypto.ts";
import { scalarToString, toPairs, toQueryString } from "./params.ts";

export interface MastodonRequest {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  token?: string;
  /** Force multipart (set automatically when the body contains files). */
  multipart?: boolean;
  /** Absolute URL override (used for streaming hosts and pagination links). */
  url?: string;
}

export interface MastodonResponse {
  status: number;
  ok: boolean;
  data: unknown;
  headers: Headers;
  /** Pagination cursors extracted from the Link header. */
  next?: Record<string, string>;
  prev?: Record<string, string>;
  nextUrl?: string;
}

export class FileInputError extends Error {}

const PAGING_KEYS = ["max_id", "min_id", "since_id", "offset"];

/** Parse `Link: <url>; rel="next", <url>; rel="prev"`. */
export function parseLink(header: string | null): { next?: string; prev?: string } {
  const out: { next?: string; prev?: string } = {};
  if (!header) return out;
  for (const part of header.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?([a-z]+)"?/i);
    if (m && (m[2] === "next" || m[2] === "prev")) out[m[2]] = m[1];
  }
  return out;
}

function cursor(url?: string): Record<string, string> | undefined {
  if (!url) return undefined;
  try {
    const sp = new URL(url).searchParams;
    const c: Record<string, string> = {};
    for (const k of PAGING_KEYS) {
      const v = sp.get(k);
      if (v) c[k] = v;
    }
    return Object.keys(c).length ? c : undefined;
  } catch {
    return undefined;
  }
}

// ---------- file inputs ----------

export type FileInput = string | { url?: string; base64?: string; data?: string; filename?: string; mime?: string };

export const looksLikeFile = (v: unknown): boolean =>
  (typeof v === "string" && (/^data:[^;,]+(;base64)?,/.test(v) || /^https?:\/\//.test(v))) ||
  (typeof v === "object" && v !== null && !Array.isArray(v) && ("base64" in v || ("url" in v && Object.keys(v).every((k) => ["url", "filename", "mime"].includes(k)))));

/**
 * Resolve a file input to a Blob. Accepts an http(s) URL, a data: URI, or
 * {url} / {base64, filename?, mime?}. URL fetches are limited to public hosts.
 */
export async function resolveFile(input: FileInput, cfg: Config): Promise<{ blob: Blob; filename: string }> {
  const obj = typeof input === "string" ? (input.startsWith("data:") ? { data: input } : { url: input }) : input;
  if (obj.base64 || obj.data) {
    let mime = obj.mime ?? "application/octet-stream";
    let b64 = obj.base64 ?? "";
    if (obj.data) {
      const m = obj.data.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
      if (!m) throw new FileInputError("invalid data: URI");
      mime = m[1];
      b64 = m[2] ? m[3] : btoa(decodeURIComponent(m[3]));
    }
    const bytes = b64urlDecode(b64.replace(/\s+/g, "").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"));
    if (bytes.length > cfg.maxUploadBytes) throw new FileInputError(`file exceeds ${cfg.maxUploadBytes} bytes`);
    return { blob: new Blob([bytes], { type: mime }), filename: obj.filename ?? `upload.${mime.split("/")[1] ?? "bin"}` };
  }
  if (obj.url) {
    let u: URL;
    try {
      u = new URL(obj.url);
    } catch {
      throw new FileInputError("invalid file url");
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new FileInputError("file url must be http(s)");
    normalizeInstance(u.host, { ...cfg, allowedInstances: [] }); // reuse public-host guard
    const res = await fetch(u, { headers: { "User-Agent": cfg.userAgent }, redirect: "follow", signal: AbortSignal.timeout(cfg.upstreamTimeoutMs) });
    if (!res.ok) throw new FileInputError(`fetching ${u.host} failed: HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > cfg.maxUploadBytes) throw new FileInputError(`file exceeds ${cfg.maxUploadBytes} bytes`);
    const blob = await res.blob();
    if (blob.size > cfg.maxUploadBytes) throw new FileInputError(`file exceeds ${cfg.maxUploadBytes} bytes`);
    const name = obj.filename ?? (decodeURIComponent(u.pathname.split("/").pop() || "") || "upload");
    return { blob: obj.mime ? new Blob([blob], { type: obj.mime }) : blob, filename: name };
  }
  throw new FileInputError("file must be a URL, data: URI, or {url} / {base64, filename, mime}");
}

// ---------- request ----------

export async function mastodonFetch(cfg: Config, instance: string, req: MastodonRequest, fileKeys: Set<string> = new Set()): Promise<MastodonResponse> {
  const base = instanceBaseUrl(instance, cfg);
  let url = req.url ?? `${base}${req.path}`;
  if (req.query && Object.keys(req.query).length) url += (url.includes("?") ? "&" : "?") + toQueryString(req.query).slice(1);
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": cfg.userAgent, ...(req.headers ?? {}) };
  if (req.token) headers.Authorization = `Bearer ${req.token}`;

  let body: BodyInit | undefined;
  if (req.body && Object.keys(req.body).length) {
    const hasFile = req.multipart || Object.keys(req.body).some((k) => fileKeys.has(k) && req.body![k] != null);
    if (hasFile) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(req.body)) {
        if (fileKeys.has(k) && v != null) {
          const { blob, filename } = await resolveFile(v as FileInput, cfg);
          fd.append(k, blob, filename);
        } else {
          for (const [pk, pv] of toPairs(v, k)) fd.append(pk, scalarToString(pv));
        }
      }
      body = fd;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.body);
    }
  }

  const res = await fetch(url, { method: req.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(cfg.upstreamTimeoutMs) });
  const text = await res.text();
  let data: unknown = text;
  if (text && (res.headers.get("content-type") ?? "").includes("json")) {
    try {
      data = JSON.parse(text);
    } catch {}
  } else if (!text) data = res.status === 204 || res.ok ? null : "";
  const link = parseLink(res.headers.get("link"));
  return { status: res.status, ok: res.ok, data, headers: res.headers, next: cursor(link.next), prev: cursor(link.prev), nextUrl: link.next };
}

// ---------- streaming (SSE) ----------

export interface StreamEvent {
  event: string;
  payload: unknown;
}

/** Collect server-sent events for up to `seconds` or `maxEvents`. */
export async function collectStream(cfg: Config, url: string, token: string | undefined, seconds: number, maxEvents: number): Promise<{ status: number; events: StreamEvent[]; error?: string }> {
  const ctrl = new AbortController();
  const headers: Record<string, string> = { Accept: "text/event-stream", "User-Agent": cfg.userAgent };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: ctrl.signal });
  } catch (e) {
    return { status: 0, events: [], error: String(e) };
  }
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    return { status: res.status, events: [], error: t.slice(0, 500) };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: StreamEvent[] = [];
  let buf = "";
  const deadline = Date.now() + seconds * 1000;
  try {
    while (events.length < maxEvents) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) => (timer = setTimeout(() => r({ done: true, value: undefined }), remaining))),
      ]);
      clearTimeout(timer);
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let idx: number;
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
        let event = "message";
        const data: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (!data.length) continue;
        const d = data.join("\n");
        let payload: unknown = d;
        try {
          payload = JSON.parse(d);
        } catch {}
        events.push({ event, payload });
        if (events.length >= maxEvents) break;
      }
    }
  } finally {
    ctrl.abort();
    reader.cancel().catch(() => {});
  }
  return { status: res.status, events };
}

// ---------- error hints ----------

export function errorHint(status: number, data: unknown, scopes: string[]): string | undefined {
  const msg = typeof data === "object" && data && "error" in data ? String((data as { error: unknown }).error) : "";
  if (status >= 300 && status < 400) return "Redirected: redirects are not followed (to protect tokens). Check the instance domain is the canonical API host.";
  if (status === 401) return "Not authenticated or token invalid. Authenticate via OAuth or send a valid Bearer token.";
  if (status === 403 && /scope/i.test(msg)) return `Token lacks a required scope${scopes.length ? `; needs one of: ${scopes.join(", ")}` : ""}. Re-authorize with that scope.`;
  if (status === 403) return "Forbidden: the account lacks permission (admin endpoints need a role with the matching permission).";
  if (status === 404) return "Not found: wrong id, not visible to this account, or the endpoint is not supported by this Mastodon version.";
  if (status === 410) return "Gone: this endpoint was removed from Mastodon.";
  if (status === 422) return "Validation failed: check parameter names/values against mastodon_api_describe.";
  if (status === 429) return "Rate limited: wait until the X-RateLimit-Reset time before retrying.";
  if (status >= 500) return "Mastodon server error; retry later.";
  return undefined;
}
