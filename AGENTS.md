# AGENTS.md — mastodon-mcp

MCP server that exposes the **entire Mastodon REST API** (user + admin/moderation) to MCP clients.
One codebase runs on **Cloudflare Workers** (`src/worker.ts`) and **Node/Docker** (`src/node.ts`).
Endpoint: `POST /{instance_domain}/mcp` (or `POST /mcp` for `DEFAULT_INSTANCE`).

## Commands

| Task | Command |
|------|---------|
| Install | `npm install` |
| Typecheck + tests (run before every commit) | `npm run check` |
| Tests only | `npm test` |
| Dev (Worker / workerd) | `npm run dev` (secrets in `.dev.vars`) |
| Dev (Node) | `npm run dev:node` |
| Build Node bundle | `npm run build` → `dist/node.mjs` |
| Docker | `docker compose up --build` |
| Regenerate endpoint catalog | `DOCS_DIR=/tmp/documentation npm run catalog` |
| Drift check vs Mastodon routes/scopes | `MASTODON_DIR=/tmp/mastodon npm run check-routes` |
| Worker bundle check | `npx wrangler deploy --dry-run --outdir /tmp/wr` |

Reference repos (clone with `--depth 1` into `/tmp` when needed): `mastodon/mastodon`, `mastodon/documentation`.

## Architecture

| Path | Responsibility |
|------|----------------|
| `src/app.ts` | Hono routes: MCP, OAuth facade, `.well-known` discovery, `llms.txt`, `catalog.json` |
| `src/mcp/protocol.ts` | JSON-RPC handling; dual-era MCP (2026-07-28 stateless `_meta` + legacy `initialize`) |
| `src/mcp/tools.ts` | Tool surface: 4 meta-tools by default; per-endpoint tools via `?expose=group,…` |
| `src/mcp/execute.ts` | Arg → request mapping, policy (READ_ONLY/DISABLE_ADMIN), streaming, error hints |
| `src/mcp/resources.ts` | `mastodon://guide`, `mastodon://docs`, `mastodon://catalog[/group]`, `mastodon://endpoint/{id}` |
| `src/catalog/endpoints.json` | **Generated.** Never hand-edit. |
| `src/catalog/overrides.ts` | Hand-written: undocumented endpoints (`extra`), docs fixes (`patches`), renamed ids (`aliases`) |
| `src/catalog/index.ts` | Catalog loading, search (synonyms/phrases), JSON Schema from bracket params |
| `src/mastodon/client.ts` | Upstream fetch, multipart/file inputs, Link-header paging, SSE collection |
| `src/mastodon/format.ts` | Token-efficient compaction (HTML→text, nested account shrinking, `select`) |
| `src/mastodon/params.ts` | Rails param encoding (`a[b][]` ⇄ nested JSON) |
| `src/auth/oauth.ts` | OAuth 2.1 facade (DCR, CIMD, PKCE, consent page, sealed tokens, refresh, revoke) |
| `src/auth/credentials.ts` | Per-request credential resolution (oauth / passthrough / apikey / anonymous) |
| `src/auth/apps.ts` | Per-instance Mastodon app registration + app tokens (cached in Store) |
| `src/auth/crypto.ts` | AES-GCM sealing via WebCrypto; purpose-bound (`a`,`r`,`c`,`s`,`k`) |
| `src/auth/scopes.ts` | Scope list (mirror of Mastodon `doorkeeper.rb`) and hierarchy |
| `src/store*.ts` | KV abstraction: Cloudflare KV / file (Node `DATA_DIR`) / memory. Caches only. |
| `src/config.ts` | All env vars. Keep in sync with `README.md` and `.env.example`. |
| `scripts/` | `generate-catalog.ts` (docs → JSON), `check-routes.ts` (drift report) |
| `test/` | Vitest; `test/helpers.ts` has `mockUpstream`, `rpc`, `callTool` |

## Hard rules

1. **Runtime-neutral code.** Only Web APIs (`fetch`, `crypto.subtle`, `Request/Response`, streams) in `src/`, except `src/node.ts` and `src/store-file.ts`. No `node:*` imports elsewhere: they break the Worker.
2. **Stateless.** No in-memory session state. Anything that must survive requests is sealed into tokens (`src/auth/crypto.ts`) or is a re-creatable cache in `Store`. Never mint `Mcp-Session-Id`.
3. **Never hand-edit `endpoints.json`.** Regenerate it. Put fixes in `overrides.ts` with a comment saying why.
4. **Do not add per-endpoint handler code.** New Mastodon endpoints must work via the catalog + generic executor. Only add special cases in `execute.ts` when the transport differs (streaming, files, redirects).
5. **Token budget.** The default `tools/list` must stay < 6000 chars (enforced by `test/tools.test.ts`). Prefer improving catalog/search data over adding tools. Keep tool descriptions short.
6. **Security invariants (tests cover these, keep them green):**
   - Instance domains go through `normalizeInstance` (SSRF guard: no IPs/localhost/private names unless `ALLOW_PRIVATE_INSTANCES`).
   - Upstream redirects are not followed (`redirect: "manual"`) so tokens never leak to other hosts.
   - Raw calls are restricted to `/api|/oauth|/.well-known|/nodeinfo|/health` paths without `..` or `//`.
   - Sealed tokens are audience-bound (`i` = instance); purposes are AAD-bound; PKCE S256 required; codes single-use.
   - Consent page requires the CSRF cookie; redirect URIs must be registered (loopback ports may vary).
   - Never log tokens, codes, or request bodies.
7. **Auth decisions belong to Mastodon.** Don't block calls based on docs' auth labels (docs can be stricter than reality). Map upstream errors to hints instead.
8. **Keep docs in sync** when changing behavior: `README.md` (users), this file (agents), `mastodon://guide` text in `src/mcp/resources.ts` (MCP agents).

## Common tasks

| Change | Do this |
|--------|---------|
| Mastodon released new/changed endpoints | `git -C /tmp/documentation pull` → `npm run catalog` → `npm run check-routes` → review `git diff src/catalog/endpoints.json` → `npm run check` |
| Endpoint exists but undocumented | Add to `extra` in `overrides.ts` with `undocumented: true`; remove once docs cover it (`check-routes` reports it) |
| Docs have a wrong param/scope | Add a `patches[id]` entry in `overrides.ts`; consider an upstream docs PR |
| Docs markdown format changed | Fix parser in `scripts/generate-catalog.ts`; diff `endpoints.json` before/after; counts are printed per kind |
| New OAuth scope in Mastodon | Add to `KNOWN_SCOPES` in `src/auth/scopes.ts` (`check-routes` reports drift) |
| New MCP spec revision | Update `MODERN_VERSIONS`/`LEGACY_VERSIONS` in `src/version.ts`; adjust `negotiate()` in `protocol.ts`; add tests in `test/protocol.test.ts` |
| Search ranks badly for a query | Add to `SYNONYMS` or `PHRASES` in `src/catalog/index.ts`; add an assertion in `test/catalog.test.ts` |
| Response too verbose | Tune `DROP_KEYS`/shrinkers in `src/mastodon/format.ts` (shape-based, never per-endpoint) |
| New config option | `src/config.ts` + `.env.example` + README table (+ `wrangler.jsonc` vars if non-secret) |

## Endpoint ids

`<docs file path, dots for slashes>.<docs anchor>`, e.g. `statuses.create`, `admin.accounts.action`, `grouped_notifications.get-grouped`.
Ids are part of the public interface (agents store them). If a regenerated catalog drops an id because the docs anchor changed, add `oldId: newId` to `aliases` in `overrides.ts`.

## Machine-readable docs (for agents using this server)

| What | URL |
|------|-----|
| Server guide + docs index | `{PUBLIC_URL}/llms.txt` |
| Full catalog (JSON) | `{PUBLIC_URL}/catalog.json` |
| Mastodon method docs (raw md) | `https://raw.githubusercontent.com/mastodon/documentation/main/content/en/methods/{group}.md` |
| Mastodon entities (raw md) | `https://raw.githubusercontent.com/mastodon/documentation/main/content/en/entities/{Entity}.md` |
| OAuth scopes | `https://raw.githubusercontent.com/mastodon/documentation/main/content/en/api/oauth-scopes.md` |
| MCP spec | `https://modelcontextprotocol.io/specification/2026-07-28` (index: `https://modelcontextprotocol.io/llms.txt`) |
| Mastodon routes (truth) | `https://raw.githubusercontent.com/mastodon/mastodon/main/config/routes/api.rb` |

## Testing conventions

- Never hit real instances in `npm test`; use `mockUpstream()` (stubs global `fetch`).
- Use `rpc()` / `callTool()` from `test/helpers.ts`; they send correct 2026-07-28 headers + `_meta`.
- Every bug fix gets a regression test. Security-relevant behavior gets an explicit negative test.
- Manual live check (public endpoints only): run the server with `AUTH_MODE=optional` and call `accounts.lookup` / `instance.v2` on `mastodon.social`.
