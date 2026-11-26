/**
 * Rails-compatible parameter encoding.
 *
 * Tool callers may pass nested JSON ({poll: {options: ["a"]}}) or the docs' flat
 * bracket names ({"poll[options][]": ["a"]}). Both are normalized to nested form,
 * then encoded as JSON (bodies), bracket query strings, or multipart fields.
 */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Blob);

/** Merge flat bracket keys into nested objects. `a[]` -> a: [...], `a[b][c]` -> a.b.c. */
export function unflatten(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!key.includes("[")) {
      out[key] = isObj(value) && isObj(out[key]) ? { ...(out[key] as object), ...value } : value;
      continue;
    }
    const m = key.match(/^([^[]+)(.*)$/)!;
    const parts = [m[1], ...[...m[2].matchAll(/\[([^\]]*)\]/g)].map((x) => x[1])];
    let node: Record<string, unknown> = out;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const last = i === parts.length - 1;
      const nextArr = parts[i + 1] === "";
      if (p === "") break;
      if (last || (nextArr && i + 1 === parts.length - 1)) {
        node[p] = nextArr && !Array.isArray(value) ? [value] : value;
        break;
      }
      if (nextArr) {
        // a[][b] — not representable unambiguously in flat form; take value as array of objects.
        node[p] = value;
        break;
      }
      node = (node[p] = isObj(node[p]) ? node[p] : {}) as Record<string, unknown>;
    }
  }
  return out;
}

/** Flatten nested values into Rails bracket pairs: {a:{b:[1,2]}} -> [["a[b][]","1"],["a[b][]","2"]]. */
export function toPairs(value: unknown, prefix = ""): [string, unknown][] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((v) => (isObj(v) || Array.isArray(v) ? toPairs(v, `${prefix}[]`) : [[`${prefix}[]`, v] as [string, unknown]]));
  }
  if (isObj(value)) {
    return Object.entries(value).flatMap(([k, v]) => toPairs(v, prefix ? `${prefix}[${k}]` : k));
  }
  return [[prefix, value]];
}

export function scalarToString(v: unknown): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

export function toQueryString(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of toPairs(params)) sp.append(k, scalarToString(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}
