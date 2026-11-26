/**
 * Generates src/catalog/endpoints.json from the official Mastodon documentation.
 *
 *   DOCS_DIR=/tmp/documentation npm run catalog
 *
 * The docs repo (https://github.com/mastodon/documentation) is the single source of
 * truth for endpoint metadata. Never hand-edit endpoints.json; put fixes and
 * undocumented endpoints in src/catalog/overrides.ts instead.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { AuthKind, Endpoint, EndpointKind, Param, ParamLocation } from "../src/catalog/types.ts";

const DOCS_DIR = process.env.DOCS_DIR ?? "/tmp/documentation";
const METHODS_DIR = join(DOCS_DIR, "content/en/methods");
const OUT = new URL("../src/catalog/endpoints.json", import.meta.url);

if (!existsSync(METHODS_DIR)) {
  console.error(`Docs not found at ${DOCS_DIR}. Clone with:\n  git clone --depth 1 https://github.com/mastodon/documentation.git ${DOCS_DIR}`);
  process.exit(1);
}

// `HTTP/1.1` suffix is missing on some docs entries (e.g. GET /api/v2/instance).
const HTTP_LINE = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)(?:\s+HTTP\/1\.1)?$/;
const HEADING = /^(#{2,3})\s+(.*)$/;
const SCOPE_RE = /`((?:admin:)?(?:read|write)(?::[a-z_]+)?|follow|push|profile)`/g;

function listMarkdown(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return listMarkdown(p);
    return e.name.endsWith(".md") && !e.name.startsWith("_") ? [p] : [];
  });
}

/** Strip Hugo shortcodes and markdown links down to plain text. */
function clean(s: string): string {
  return s
    .replace(/\{\{<\s*required\s*>\}\}\s*/g, "")
    .replace(/\{\{%\s*optional\s*%\}\}\s*/g, "")
    .replace(/\[([^\]]+)\]\(\{\{<[^>]*>\}\}\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\{\{[<%][^}]*[>%]\}\}/g, "")
    .replace(/\*\*/g, "")
    .replace(/\\$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** First sentence, capped, for token-efficient descriptions. */
function firstSentence(s: string, max = 160): string {
  const c = clean(s);
  const m = c.match(/^(.+?[.!?])(\s|$)/);
  let out = m ? m[1] : c;
  if (out.length > max) out = out.slice(0, max - 1).trimEnd() + "…";
  return out;
}

function parseAuth(raw: string | undefined): { auth: AuthKind; scopes: string[] } {
  if (!raw) return { auth: "public", scopes: [] };
  const scopes = [...new Set([...raw.matchAll(SCOPE_RE)].map((m) => m[1]))];
  const r = raw.toLowerCase();
  let auth: AuthKind;
  if (r.startsWith("public")) auth = /user|app token/.test(r) ? "optional" : "public";
  else if (r.startsWith("app token")) auth = "app";
  else if (r.startsWith("user")) auth = "user";
  else auth = "optional";
  return { auth, scopes };
}

function parseType(desc: string): { type: string; enumValues?: string[] } {
  const c = clean(desc);
  const typeMatch = c.match(/^([A-Z][A-Za-z ]*?(?:\([^)]*\))?)\.(\s|$)/);
  let type = typeMatch ? typeMatch[1].trim() : "";
  if (!type) {
    if (/multipart|encoded using/i.test(c)) type = "File";
    else type = "String";
  }
  const enumValues: string[] = [];
  const oneOf = type.match(/oneOf\s+(.*)\)/);
  if (oneOf) for (const m of oneOf[1].matchAll(/`([^`]+)`/g)) enumValues.push(m[1]);
  return { type, enumValues: enumValues.length ? enumValues : undefined };
}

function normalizeType(t: string, name: string, desc: string): { t: string; file?: boolean } {
  const s = t.toLowerCase();
  if (s === "file" || /multipart/i.test(desc) && /file|image|avatar|header|thumbnail|data/.test(name)) return { t: "file", file: true };
  if (s.startsWith("array of integer")) return { t: "int[]" };
  if (s.startsWith("array of hash") || s.startsWith("array of object")) return { t: "object[]" };
  if (s.startsWith("array")) return { t: "string[]" };
  if (s.startsWith("string or array")) return { t: "string|string[]" };
  if (s.startsWith("boolean")) return { t: "bool" };
  if (s.startsWith("integer")) return { t: "int" };
  if (s.startsWith("number")) return { t: "number" };
  if (s.startsWith("hash") || s.startsWith("object")) return { t: "object" };
  if (s.includes("datetime") || s.includes("date")) return { t: "datetime" };
  return { t: "string" };
}

interface DefItem { name: string; lines: string[] }

/** Parse a Hugo definition list (`name` line followed by `: description` lines). */
function parseDefList(lines: string[]): DefItem[] {
  const items: DefItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] ?? "";
    if (line.trim() && !line.startsWith(": ") && !line.startsWith("#") && next.startsWith(": ")) {
      // Some docs write names as `:id[]`; strip the stray leading colon.
      const item: DefItem = { name: line.trim().replace(/^:(?=[a-z])/, ""), lines: [next.slice(2)] };
      let j = i + 2;
      while (j < lines.length && lines[j].trim() !== "" && !lines[j].startsWith("#")) {
        item.lines.push(lines[j].startsWith(": ") ? lines[j].slice(2) : lines[j]);
        j++;
      }
      items.push(item);
      i = j - 1;
    }
  }
  return items;
}

function sectionLocation(header: string, method: string): ParamLocation | "skip" {
  const h = header.toLowerCase();
  if (h.startsWith("path")) return "path";
  if (h.startsWith("query")) return "query";
  if (h.startsWith("form")) return "body";
  if (h.startsWith("headers")) return "header";
  if (h === "parameters") return method === "GET" || method === "DELETE" ? "query" : "body";
  return "skip";
}

function parseParams(sectionLines: string[], method: string): Param[] {
  const params: Param[] = [];
  let loc: ParamLocation | "skip" = "skip";
  let buf: string[] = [];
  const flush = () => {
    if (loc === "skip") return;
    for (const item of parseDefList(buf)) {
      const name = item.name.replace(/^`|`$/g, "");
      const first = item.lines[0];
      if (loc === "header" && /^authorization$/i.test(name)) continue;
      if (params.some((p) => p.name === name && p.in === loc)) continue;
      const required = /\{\{<\s*required\s*>\}\}/.test(first);
      const { type, enumValues } = parseType(first);
      const norm = normalizeType(type, name, first);
      const enums = [...(enumValues ?? [])];
      for (const l of item.lines.slice(1)) {
        const m = l.match(/^`([^`]+)`\s*=/);
        if (m && !enums.includes(m[1])) enums.push(m[1]);
      }
      let d = firstSentence(first.replace(/^[^.]*?\.\s*/, (m) => (/^\s*\{\{<\s*required/.test(m) || /^[A-Z][A-Za-z ]*?(\([^)]*\))?\.\s*$/.test(clean(m)) ? "" : m)));
      if (/internal parameter/i.test(first)) d = "Pagination cursor (prefer Link-header paging).";
      const p: Param = { name, in: loc, type: norm.t };
      if (required) p.required = true;
      if (norm.file) p.file = true;
      if (enums.length) p.enum = enums;
      if (d) p.desc = d;
      params.push(p);
    }
  };
  for (const line of sectionLines) {
    // Param sections are normally `#####`, but some docs use `####`.
    const h = line.match(/^#{4,5}\s+(.*)$/);
    if (h && (line.startsWith("#####") || sectionLocation(h[1].trim(), method) !== "skip")) {
      flush();
      buf = [];
      loc = sectionLocation(h[1].trim(), method);
      continue;
    }
    if (/^#{1,4}\s/.test(line)) {
      flush();
      buf = [];
      loc = "skip";
      continue;
    }
    buf.push(line);
  }
  flush();
  return params;
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Map lowercase entity refs (docs use inconsistent case) to real entity file names.
const ENTITIES_DIR = join(DOCS_DIR, "content/en/entities");
const entityNames = new Map(
  readdirSync(ENTITIES_DIR)
    .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
    .map((f) => [f.replace(/\.md$/, "").toLowerCase(), f.replace(/\.md$/, "")]),
);
function parseEntities(returnsLine: string): string[] {
  const out = new Set<string>();
  for (const m of returnsLine.matchAll(/relref\s+"entities\/([A-Za-z_]+)/g)) {
    const name = entityNames.get(m[1].toLowerCase());
    if (name) out.add(name);
  }
  return [...out];
}

const endpoints: Endpoint[] = [];
const files = listMarkdown(METHODS_DIR).sort();

for (const file of files) {
  const rel = relative(METHODS_DIR, file).replace(/\.md$/, "");
  const group = rel.replace(/\//g, ".");
  const lines = readFileSync(file, "utf8").split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "```http") continue;
    const httpLine = lines[i + 1]?.trim() ?? "";
    const m = httpLine.match(HTTP_LINE);
    const ws = httpLine.startsWith("wss://");
    if (!m && !ws) continue;

    // Find the heading this block belongs to: it must be the first block after the heading.
    let h = i - 1;
    while (h >= 0 && !HEADING.test(lines[h])) {
      if (lines[h].startsWith("```")) break;
      h--;
    }
    const hm = h >= 0 ? lines[h].match(HEADING) : null;
    if (!hm) continue;
    const level = hm[1].length;
    const headingText = hm[2];
    if (/\{\{%\s*removed\s*%\}\}/.test(headingText)) continue;

    // Section spans until the next heading of the same or higher level.
    let end = h + 1;
    while (end < lines.length) {
      const nh = lines[end].match(/^(#{1,6})\s/);
      if (nh && nh[1].length <= level) break;
      end++;
    }
    const section = lines.slice(h + 1, end);
    const text = section.join("\n");

    const anchorMatch = headingText.match(/\{#?([\w-]+)\}\s*$/);
    const title = clean(headingText.replace(/\{#?[\w-]+\}\s*$/, "").replace(/\{\{%[^%]*%\}\}/g, ""));
    const anchor = anchorMatch ? anchorMatch[1] : slug(title);

    const method = ws ? "GET" : m![1];
    const path = ws ? "/api/v1/streaming" : m![2].replace(/\?.*$/, "");

    const oauthLine = text.match(/^\*\*OAuth:\*\*\s*(.+?)\\?$/m)?.[1];
    const returnsLine = text.match(/^\*\*Returns:\*\*\s*(.+?)\\?$/m)?.[1];
    const { auth, scopes } = parseAuth(oauthLine);

    const versionBlock = text.match(/\*\*Version history:\*\*\\?\n([\s\S]*?)(\n\n|\n#)/)?.[1] ?? "";
    const addedLine = versionBlock.split("\n").find((l) => /added/i.test(l)) ?? versionBlock.split("\n")[0] ?? "";
    const since = addedLine.match(/^(\d+\.\d+\.\d+)/)?.[1];
    const apiVersion = addedLine.match(/API version[^)]*\)\s*(\d+)/)?.[1] ?? addedLine.match(/`mastodon`[^)]*?(\d+)\)/)?.[1];

    // Description: first paragraph of prose after the http block.
    const afterBlock = lines.slice(i + 3, end);
    const descLine = afterBlock.find((l) => l.trim() && !l.startsWith("**") && !l.startsWith("#") && !l.startsWith("{{") && !l.startsWith("```"));

    let kind: EndpointKind = "rest";
    if (ws) kind = "websocket";
    else if (path.startsWith("/api/v1/streaming") && path !== "/api/v1/streaming/health") kind = "stream";
    else if (path === "/oauth/authorize") kind = "browser";

    const params = ws ? [] : parseParams(section, method);
    for (const seg of path.matchAll(/:([a-z_]+)/g)) {
      if (!params.some((p) => p.in === "path" && p.name === seg[1])) {
        params.unshift({ name: seg[1], in: "path", type: "string", required: true });
      }
    }
    for (const p of params) if (p.in === "path") p.required = true;

    const ep: Endpoint = {
      id: `${group}.${anchor}`,
      group,
      method,
      path,
      title,
      auth,
      scopes,
      params,
      doc: `${rel}#${anchor}`,
    };
    if (descLine) ep.desc = firstSentence(descLine, 200);
    if (oauthLine && !/^(Public|User token \+ `[a-z:_]+`|App token|User token)\\?$/.test(oauthLine.trim())) ep.authNote = clean(oauthLine);
    if (returnsLine) {
      ep.returns = firstSentence(returnsLine, 120).replace(/\.$/, "");
      const entities = parseEntities(returnsLine);
      if (entities.length) ep.entities = entities;
    }
    if (since) ep.since = since;
    if (apiVersion) ep.apiVersion = Number(apiVersion);
    if (/\{\{%\s*deprecated\s*%\}\}/.test(headingText)) ep.deprecated = true;
    if (kind !== "rest") ep.kind = kind;
    endpoints.push(ep);
  }
}

// Disambiguate duplicate ids (should not happen; warn loudly if it does).
const seen = new Map<string, number>();
for (const ep of endpoints) {
  const n = seen.get(ep.id) ?? 0;
  if (n) {
    console.warn(`duplicate id ${ep.id}; suffixing`);
    ep.id = `${ep.id}-${n + 1}`;
  }
  seen.set(ep.id, n + 1);
}

let docsCommit = "unknown";
try {
  docsCommit = execFileSync("git", ["-C", DOCS_DIR, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {}

endpoints.sort((a, b) => a.id.localeCompare(b.id));
const out = { source: "https://github.com/mastodon/documentation", commit: docsCommit, generated: new Date().toISOString().slice(0, 10), endpoints };
writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");

const byKind = endpoints.reduce<Record<string, number>>((acc, e) => ((acc[e.kind ?? "rest"] = (acc[e.kind ?? "rest"] ?? 0) + 1), acc), {});
console.log(`Wrote ${endpoints.length} endpoints from ${files.length} files (${basename(DOCS_DIR)}@${docsCommit.slice(0, 8)})`, byKind);
