/** Node.js entry (Docker / local). Config comes from process.env. */
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { MemoryStore, type Store } from "./store.ts";
import { FileStore } from "./store-file.ts";

const cfg = loadConfig(process.env);
const store: Store = process.env.DATA_DIR ? new FileStore(process.env.DATA_DIR) : new MemoryStore();
const app = createApp({ cfg, store });

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? "127.0.0.1";

if (!cfg.secretKey) console.warn("[mastodon-mcp] SECRET_KEY not set: OAuth facade disabled (Bearer passthrough / API keys only).");
if (!cfg.publicUrl) console.warn("[mastodon-mcp] PUBLIC_URL not set: inferring from request Host header.");

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`[mastodon-mcp] listening on http://${info.address}:${info.port}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
