# mastodon-mcp

An MCP server for the **whole Mastodon REST API**: every documented user endpoint plus all admin and moderation endpoints. It runs on **Cloudflare Workers** or **Docker/Node**.

```
https://your-server/{instance_domain}/mcp      e.g. https://mcp.example.com/mastodon.social/mcp
https://your-server/mcp                        (DEFAULT_INSTANCE)
```

- **280 endpoints**, generated from [mastodon/documentation](https://github.com/mastodon/documentation), plus undocumented routes found in Mastodon's source. Includes streaming (SSE) and media uploads.
- **Low token cost:** 4 meta-tools (~1k tokens) instead of ~270 tools (~63k tokens). Responses are compacted by default (HTML→text, nested accounts shrunk, nulls dropped) and support `select` field projection.
- **Auth:** OAuth (MCP clients log in through the browser), Bearer passthrough of a Mastodon token, server-side API keys, or a mix.
- **MCP 2026-07-28** (stateless) and legacy `initialize` clients (2025-03-26 … 2025-11-25).

## Quick start

### Docker

```sh
cp .env.example .env          # set SECRET_KEY (openssl rand -base64 32) and PUBLIC_URL
docker compose up --build -d  # listens on 127.0.0.1:8787
```

For OAuth from remote clients, put a TLS reverse proxy in front and set `PUBLIC_URL` (or `TRUST_PROXY=true`).

### Cloudflare Workers

```sh
npm install
npx wrangler secret put SECRET_KEY
npx wrangler kv namespace create MCP_KV   # optional; add the binding to wrangler.jsonc
npm run deploy
```

### Local

```sh
npm install && SECRET_KEY=dev npm run dev:node     # Node
npm run dev                                        # workerd (secrets in .dev.vars)
```

## Connecting a client

Add `https://your-server/mastodon.social/mcp` as a remote (Streamable HTTP) MCP server.

| Auth mode | What the client does |
|-----------|----------------------|
| **OAuth** (needs `SECRET_KEY`) | Nothing special. The client gets a 401, discovers `/.well-known/oauth-protected-resource/...`, registers (DCR or Client ID Metadata Document), and opens a browser. You approve on a consent page, then sign in on your instance. |
| **Bearer** | `Authorization: Bearer <Mastodon access token>` (create one in Mastodon: Preferences → Development). |
| **API key** | `Authorization: Bearer <MCP_API_KEYS entry>`. The server uses `MASTODON_TOKEN(S)` upstream. |
| **Mixed** | API key or OAuth token in `Authorization`, plus `X-Mastodon-Token: <user token>` for upstream calls. |
| **Anonymous** | `AUTH_MODE=optional`: public endpoints only. |

Admin endpoints need `admin:read`/`admin:write` scopes (on by default in `APP_SCOPES`) **and** a staff role on the account.

## Tools

| Tool | Purpose |
|------|---------|
| `mastodon_api_search` | Find endpoints by keyword (`"boost"`, `"suspend account"`). One line per result. `{}` lists groups. |
| `mastodon_api_describe` | Params, scopes, return entity, version, raw docs URL. `schema:true` adds JSON Schema. |
| `mastodon_api_call` | `{id, args}` for catalog endpoints, or `{method, path, query, body}` for raw access. Supports `select`, `format`, `pages`, `idempotency_key`, and streaming `seconds`/`max_events`. |
| `mastodon_auth` | Current account, auth mode, scopes, server version. |

Example:

```json
{"id":"statuses.create","args":{"status":"Hello","poll":{"options":["a","b"],"expires_in":3600}},"idempotency_key":"…"}
{"id":"timelines.home","args":{"limit":20},"select":["id","account.acct","content"]}
{"id":"media.v2","args":{"file":{"url":"https://…/cat.jpg"},"description":"A cat"}}
{"id":"admin.accounts.action","args":{"id":"123","type":"silence","text":"spam"}}
```

To get one tool per endpoint, add `?expose=statuses,timelines` (or `?expose=all`) to the MCP URL.

**Resources:** `mastodon://guide`, `mastodon://docs` (raw doc URLs), `mastodon://catalog[/{group}]`, `mastodon://endpoint/{id}`.
**Prompts:** `catch_up`, `moderation_queue`, `compose_post`.

## Machine-readable docs

| URL | Content |
|-----|---------|
| `/llms.txt`, `/{instance}/llms.txt` | Agent guide + raw docs index |
| `/catalog.json` | Full endpoint catalog (method, path, params, scopes, docs links) |
| `https://raw.githubusercontent.com/mastodon/documentation/main/content/en/methods/{group}.md` | Mastodon method docs |
| `https://raw.githubusercontent.com/mastodon/documentation/main/content/en/entities/{Entity}.md` | Entity docs |

## Configuration

All settings are environment variables (Worker vars/secrets or `.env`).

| Variable | Default | Description |
|----------|---------|-------------|
| `SECRET_KEY` | — | Enables OAuth; seals tokens. **Rotating it invalidates all issued tokens.** |
| `PUBLIC_URL` | from request | Public origin, used for OAuth redirects and metadata |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-Proto/Host` when `PUBLIC_URL` is unset |
| `DEFAULT_INSTANCE` | — | Instance served at `/mcp` |
| `ALLOWED_INSTANCES` | any public | Comma-separated allowlist |
| `AUTH_MODE` | `required` | `optional` allows anonymous use of public endpoints |
| `ALLOW_PASSTHROUGH` | `true` | Accept raw Mastodon tokens (`Authorization` / `X-Mastodon-Token`) |
| `DEFAULT_SCOPES` | `read write follow push profile` | Requested when the client doesn't specify scopes |
| `APP_SCOPES` | `… admin:read admin:write` | Upper bound for scopes; the app is registered with these |
| `TOKEN_TTL_SECONDS` | `2592000` | Access token lifetime (refresh tokens don't expire) |
| `SCOPE_STEP_UP` | `false` | Reply HTTP 403 `insufficient_scope` so clients re-authorize with more scopes |
| `MCP_API_KEYS` | — | Comma-separated static keys |
| `MASTODON_TOKEN` / `MASTODON_TOKENS` | — | Server-side tokens for API-key users (`{"domain":"token"}`) |
| `MASTODON_APPS` | auto-register | Pre-registered apps `{"domain":{"client_id","client_secret"}}`; redirect URI must be `{PUBLIC_URL}/oauth/callback` |
| `READ_ONLY` | `false` | Block mutating calls |
| `DISABLE_ADMIN` | `false` | Hide and block admin endpoints |
| `ALLOWED_ORIGINS` | same-origin | Browser origins allowed to call `/mcp` (`*` allows all) |
| `MAX_OUTPUT_CHARS` | `40000` | Truncation limit per tool result |
| `UPSTREAM_TIMEOUT_MS` | `30000` | Mastodon request timeout |
| `MAX_UPLOAD_BYTES` | `104857600` | Media upload limit |
| `HTTP_INSTANCES`, `ALLOW_PRIVATE_INSTANCES` | — / `false` | Local development against e.g. `localhost:3000` |
| `HOST`, `PORT`, `DATA_DIR` | `127.0.0.1`, `8787`, — | Node/Docker only. `DATA_DIR` persists caches. |
| `USER_AGENT` | `mastodon-mcp/0.1` | Upstream User-Agent |

## Security notes

- The server stores no user data. Tokens are AES-GCM sealed and bound to one instance. The store holds only caches (registered apps, instance metadata).
- Instance domains must be public DNS names (SSRF guard). Redirects from Mastodon are never followed, so tokens can't leak.
- Every new OAuth connection goes through a consent page naming the client and its redirect host.

## Development

See [AGENTS.md](AGENTS.md). Short version: `npm run check` before committing. When Mastodon changes, run `npm run catalog` and `npm run check-routes`.

License: AGPL-3.0-or-later.
