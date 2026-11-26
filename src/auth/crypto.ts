/**
 * Stateless sealing (AES-256-GCM via WebCrypto; works in Workers and Node >= 20).
 *
 * Everything the OAuth facade hands out (client ids, auth codes, access/refresh tokens,
 * upstream `state`) is an encrypted, authenticated blob, so no database is needed.
 * The `purpose` is bound as AAD: a sealed auth code can never be replayed as a token.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

export type Purpose = "a" | "r" | "c" | "s" | "k"; // access, refresh, client, upstream state, auth code
export const TOKEN_PREFIX = "mmcp";

const keyCache = new Map<string, Promise<CryptoKey>>();

function getKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = (async () => {
      const raw = await crypto.subtle.digest("SHA-256", enc.encode(`mastodon-mcp:v1:${secret}`));
      return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    })();
    keyCache.set(secret, k);
  }
  return k;
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256b64url(input: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(input))));
}

/** Seal a JSON payload. `ttlSeconds` adds an `exp` that `unseal` enforces. */
export async function seal(secret: string, purpose: Purpose, payload: Record<string, unknown>, ttlSeconds?: number): Promise<string> {
  const body = ttlSeconds ? { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds } : payload;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(purpose) }, await getKey(secret), enc.encode(JSON.stringify(body))),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return `${TOKEN_PREFIX}.${purpose}.${b64url(out)}`;
}

export async function unseal<T extends Record<string, unknown>>(secret: string, purpose: Purpose, token: string): Promise<T | null> {
  const prefix = `${TOKEN_PREFIX}.${purpose}.`;
  if (!token.startsWith(prefix)) return null;
  try {
    const raw = b64urlDecode(token.slice(prefix.length));
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.subarray(0, 12), additionalData: enc.encode(purpose) },
      await getKey(secret),
      raw.subarray(12),
    );
    const obj = JSON.parse(dec.decode(pt)) as T & { exp?: number };
    if (typeof obj.exp === "number" && obj.exp < Date.now() / 1000) return null;
    return obj;
  } catch {
    return null;
  }
}

export const isSealed = (token: string, purpose?: Purpose) => token.startsWith(`${TOKEN_PREFIX}.${purpose ?? ""}`);

export async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  return (await sha256b64url(verifier)) === challenge;
}

/** Constant-time string compare. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
