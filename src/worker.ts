/** Cloudflare Workers entry. Config comes from `env` (wrangler vars + secrets). */
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { KVStore, MemoryStore, type KVLike, type Store } from "./store.ts";

type Env = Record<string, unknown> & { MCP_KV?: KVLike };

const memory = new MemoryStore();
let cached: { env: Env; app: ReturnType<typeof createApp> } | undefined;

export default {
  fetch(request: Request, env: Env, ctx: unknown) {
    if (!cached || cached.env !== env) {
      const store: Store = env.MCP_KV ? new KVStore(env.MCP_KV) : memory;
      cached = { env, app: createApp({ cfg: loadConfig(env), store }) };
    }
    return cached.app.fetch(request, env, ctx as never);
  },
};
