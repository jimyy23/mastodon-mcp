import type { Config } from "./config.ts";

export class InstanceError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}[a-z0-9](?::\d{1,5})?$/;
const PRIVATE_RE = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa)(:\d+)?$/;
const IP_RE = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])(:\d+)?$/;

/**
 * Normalize and validate an instance domain from the URL path. This is the SSRF guard:
 * only public DNS names are allowed unless ALLOW_PRIVATE_INSTANCES is set.
 * Note: names that resolve to private IPs can't be detected here (no DNS in Workers);
 * use ALLOWED_INSTANCES for strict deployments.
 */
export function normalizeInstance(raw: string, cfg: Config): string {
  let d = decodeURIComponent(raw).trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!d) throw new InstanceError("missing instance domain");
  const isPrivate = IP_RE.test(d) || PRIVATE_RE.test(d) || !d.includes(".");
  if (isPrivate && !cfg.allowPrivateInstances) throw new InstanceError(`instance "${d}" is not a public domain`, 403);
  if (!isPrivate && !DOMAIN_RE.test(d)) throw new InstanceError(`invalid instance domain "${d}"`);
  if (cfg.allowedInstances.length && !cfg.allowedInstances.includes(d)) throw new InstanceError(`instance "${d}" is not allowed on this server`, 403);
  return d;
}

export function instanceBaseUrl(domain: string, cfg: Config): string {
  return `${cfg.httpInstances.includes(domain) ? "http" : "https"}://${domain}`;
}
