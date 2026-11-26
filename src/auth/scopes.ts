/**
 * Mastodon OAuth scopes, mirrored from mastodon/config/initializers/doorkeeper.rb
 * (`optional_scopes`). Update when Mastodon adds scopes; `npm run check-routes`
 * reports drift if the Mastodon repo is available.
 */
export const KNOWN_SCOPES = [
  "profile",
  "read", "read:accounts", "read:blocks", "read:bookmarks", "read:collections", "read:favourites", "read:filters",
  "read:follows", "read:lists", "read:mutes", "read:notifications", "read:search", "read:statuses",
  "write", "write:accounts", "write:blocks", "write:bookmarks", "write:collections", "write:conversations",
  "write:favourites", "write:filters", "write:follows", "write:lists", "write:media", "write:mutes",
  "write:notifications", "write:reports", "write:statuses",
  "follow", "push",
  "admin:read", "admin:read:accounts", "admin:read:reports", "admin:read:domain_allows", "admin:read:domain_blocks",
  "admin:read:ip_blocks", "admin:read:email_domain_blocks", "admin:read:canonical_email_blocks",
  "admin:write", "admin:write:accounts", "admin:write:reports", "admin:write:domain_allows", "admin:write:domain_blocks",
  "admin:write:ip_blocks", "admin:write:email_domain_blocks", "admin:write:canonical_email_blocks",
];

const FOLLOW_IMPLIES = new Set(["read:blocks", "write:blocks", "read:follows", "write:follows", "read:mutes", "write:mutes"]);

/** `read:statuses` -> `read`; `admin:write:accounts` -> `admin:write`. */
export function parentScope(scope: string): string | undefined {
  const parts = scope.split(":");
  if (parts[0] === "admin") return parts.length === 3 ? `admin:${parts[1]}` : undefined;
  return parts.length === 2 ? parts[0] : undefined;
}

export function hasScope(granted: string[], scope: string): boolean {
  if (granted.includes(scope)) return true;
  const parent = parentScope(scope);
  if (parent && granted.includes(parent)) return true;
  if (FOLLOW_IMPLIES.has(scope) && granted.includes("follow")) return true;
  // `profile` is a subset of read:accounts for verify_credentials.
  return false;
}

/** Docs list alternatives (e.g. ["write:follows", "follow"]); any one suffices. */
export function satisfies(granted: string[], required: string[]): boolean {
  if (!required.length) return true;
  return required.some((s) => hasScope(granted, s));
}

export const splitScopes = (s: string | undefined | null) => (s ?? "").split(/[\s+]+/).filter(Boolean);

/** Is `scope` allowed by an app registered with `appScopes` (exact or via parent)? */
export function allowedByApp(appScopes: string[], scope: string): boolean {
  return appScopes.includes(scope) || (!!parentScope(scope) && appScopes.includes(parentScope(scope)!));
}

/**
 * Scopes to register our Mastodon app with. Doorkeeper compares scopes as exact strings,
 * so to let MCP clients request granular scopes (`read:statuses`) the app must list them.
 * We expand APP_SCOPES families using what the instance supports.
 */
export function expandAppScopes(configured: string[], instanceSupported?: string[]): string[] {
  const universe = instanceSupported?.length ? instanceSupported : KNOWN_SCOPES;
  const out = new Set<string>();
  for (const s of universe) if (allowedByApp(configured, s)) out.add(s);
  if (!instanceSupported?.length) for (const s of configured) out.add(s);
  return [...out];
}
