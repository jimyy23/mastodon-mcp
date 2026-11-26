/**
 * Response shaping for token efficiency. Everything here is entity-agnostic (driven by
 * key names/shapes, not per-endpoint code) so new API fields work without changes.
 *
 * compact (default):
 *  - drops null / "" / [] / {} values and noisy keys (DROP_KEYS)
 *  - converts HTML strings (content, note, field values…) to plain text
 *  - shrinks *nested* accounts to {id, acct, display_name, bot?}
 *  - shrinks media attachments, preview cards, applications
 * full: Mastodon's JSON untouched (still minified).
 */

const DROP_KEYS = new Set(["avatar_static", "header_static", "emojis", "static_url", "blurhash", "preview_remote_url", "text_url"]);
const HTML_RE = /^\s*<(p|span|a|br|div|h[1-6]|ul|ol|li|blockquote|pre|code|b|i|em|strong)[\s>/]/i;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|blockquote|pre)>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<span class="invisible">[^<]*<\/span>/gi, "")
    .replace(/<span class="ellipsis">([^<]*)<\/span>/gi, "$1…")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_, href: string, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, "");
      // Mentions/hashtags keep their text; external links keep the full URL.
      return /^[@#]/.test(text) ? text : href;
    })
    .replace(/<[^>]+>/g, "")
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e] ?? (e.startsWith("#") ? String.fromCodePoint(Number(e.slice(1).replace(/^x/, "0x"))) : m))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isAccount = (o: Record<string, unknown>) => "acct" in o && "username" in o && "id" in o;
const isMedia = (o: Record<string, unknown>) => "type" in o && "url" in o && "preview_url" in o;
const isCard = (o: Record<string, unknown>) => "url" in o && "title" in o && "provider_name" in o;

function shrinkAccount(o: Record<string, unknown>) {
  const out: Record<string, unknown> = { id: o.id, acct: o.acct };
  if (o.display_name && o.display_name !== o.username) out.display_name = o.display_name;
  if (o.bot) out.bot = true;
  if (o.group) out.group = true;
  return out;
}

function compactValue(v: unknown, depth: number, key?: string): unknown {
  if (typeof v === "string") return HTML_RE.test(v) ? htmlToText(v) : v;
  if (Array.isArray(v)) {
    const arr = v.map((x) => compactValue(x, depth + 1)).filter((x) => !isEmpty(x));
    return arr;
  }
  if (!isObj(v)) return v;
  // Nested entity shrinking (never the top-level object the user asked for).
  if (depth > 0 && isAccount(v) && key !== "target_account") return shrinkAccount(v);
  if (isMedia(v)) {
    const m: Record<string, unknown> = { id: v.id, type: v.type, url: v.url ?? v.remote_url };
    if (v.description) m.description = v.description;
    return m;
  }
  if (depth > 0 && isCard(v)) {
    const c: Record<string, unknown> = { url: v.url, title: v.title };
    if (v.description) c.description = v.description;
    return c;
  }
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (DROP_KEYS.has(k)) continue;
    if (k === "application" && depth > 0) continue;
    const c = compactValue(val, depth + 1, k);
    if (isEmpty(c)) continue;
    out[k] = c;
  }
  return out;
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isObj(v)) return Object.keys(v).length === 0;
  return false;
}

export function compact(data: unknown): unknown {
  if (Array.isArray(data)) return data.map((x) => compactValue(x, 0)).filter((x) => !isEmpty(x));
  return compactValue(data, 0);
}

/**
 * Field projection. Paths are dot-separated; arrays are mapped transparently.
 * ["id", "account.acct", "media_attachments.url"]
 */
export function select(data: unknown, paths: string[]): unknown {
  type Tree = { [k: string]: Tree | true };
  const tree: Tree = {};
  for (const p of paths) {
    let node = tree;
    const parts = p.split(".").filter(Boolean);
    parts.forEach((part, i) => {
      if (i === parts.length - 1) node[part] = true;
      else {
        const next = node[part];
        if (next === true) return;
        node = node[part] = (next as Tree) ?? {};
      }
    });
  }
  const apply = (v: unknown, t: Tree): unknown => {
    if (Array.isArray(v)) return v.map((x) => apply(x, t));
    if (!isObj(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, sub] of Object.entries(t)) {
      if (!(k in v)) continue;
      out[k] = sub === true ? v[k] : apply(v[k], sub);
    }
    return out;
  };
  return apply(data, tree);
}

/**
 * Serialize, truncating to `max` chars. Arrays drop trailing items (and say so);
 * other values are cut. Returns the JSON string.
 */
export function serialize(envelope: Record<string, unknown>, dataKey: string, max: number): string {
  const full = JSON.stringify(envelope);
  if (full.length <= max) return full;
  const data = envelope[dataKey];
  if (Array.isArray(data)) {
    const base = JSON.stringify({ ...envelope, [dataKey]: [] }).length + 120;
    let used = base;
    let n = 0;
    for (const item of data) {
      const len = JSON.stringify(item).length + 1;
      if (used + len > max) break;
      used += len;
      n++;
    }
    return JSON.stringify({
      ...envelope,
      truncated: `showing ${n} of ${data.length} items (output limit). Use select, a smaller limit, or paging.`,
      [dataKey]: data.slice(0, n),
    });
  }
  return full.slice(0, max) + `…[truncated ${full.length - max} chars; use select to pick fields]`;
}
