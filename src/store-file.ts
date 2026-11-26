import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.ts";

/** Node-only persistent store: one JSON file, written atomically. Not imported by the Worker. */
export class FileStore implements Store {
  private file: string;
  private data: Record<string, { v: string; exp?: number }> = {};
  private timer?: ReturnType<typeof setTimeout>;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "store.json");
    try {
      this.data = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      this.data = {};
    }
  }

  private flush() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const now = Date.now();
      for (const [k, e] of Object.entries(this.data)) if (e.exp && e.exp < now) delete this.data[k];
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      renameSync(tmp, this.file);
    }, 200);
  }

  async get(key: string) {
    const e = this.data[key];
    if (!e) return null;
    if (e.exp && e.exp < Date.now()) {
      delete this.data[key];
      return null;
    }
    return e.v;
  }
  async put(key: string, value: string, ttlSeconds?: number) {
    this.data[key] = { v: value, exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined };
    this.flush();
  }
  async delete(key: string) {
    delete this.data[key];
    this.flush();
  }
}
