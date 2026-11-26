export const SERVER_NAME = "mastodon-mcp";
export const SERVER_VERSION = "0.1.0";

/** Stateless, per-request `_meta` protocol revisions. Newest first. */
export const MODERN_VERSIONS = ["2026-07-28"] as const;
/** `initialize`-handshake revisions served statelessly (no Mcp-Session-Id). Newest first. */
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const ALL_VERSIONS: string[] = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

export const SERVER_INFO = { name: SERVER_NAME, version: SERVER_VERSION, title: "Mastodon MCP" };

/** Raw, machine-readable Mastodon documentation (markdown source of docs.joinmastodon.org). */
export const DOCS_RAW_BASE = "https://raw.githubusercontent.com/mastodon/documentation/main/content/en";
export const DOCS_WEB_BASE = "https://docs.joinmastodon.org";
