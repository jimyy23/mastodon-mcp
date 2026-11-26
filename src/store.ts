/**
 * Tiny key-value store abstraction. Used only for caches (registered Mastodon apps,
 * instance metadata, used OAuth codes), so losing it is never fatal.
 *
 * Worker: Cloudflare KV if the `MCP_KV` binding exists, else per-isolate memory.
 * Node: file-backed store (src/store-file.ts) if DATA_DIR is set, else memory.
 */
export interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryStore implements Store {
  private map = new Map<string, { v: string; exp?: number }>();
  async get(key: string) {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.exp && e.exp < Date.now()) {
      this.map.delete(key);
      return null;
    }
    return e.v;
  }
  async put(key: string, value: string, ttlSeconds?: number) {
    if (this.map.size > 10_000) this.map.clear();
    this.map.set(key, { v: value, exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined });
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

/** Minimal shape of a Cloudflare KV namespace, so we don't need workers-types. */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export class KVStore implements Store {
  constructor(private kv: KVLike) {}
  get(key: string) {
    return this.kv.get(key);
  }
  put(key: string, value: string, ttlSeconds?: number) {
    // KV requires a TTL of at least 60 seconds.
    return this.kv.put(key, value, ttlSeconds ? { expirationTtl: Math.max(60, ttlSeconds) } : undefined);
  }
  delete(key: string) {
    return this.kv.delete(key);
  }
}

export async function getJson<T>(store: Store, key: string): Promise<T | null> {
  const v = await store.get(key);
  if (!v) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

export function putJson(store: Store, key: string, value: unknown, ttlSeconds?: number) {
  return store.put(key, JSON.stringify(value), ttlSeconds);
}
