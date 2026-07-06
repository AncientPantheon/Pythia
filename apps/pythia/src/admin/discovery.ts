import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";

/**
 * The subset of the hub's OIDC discovery document Pythia consumes. Per the
 * integration contract (MUST #8) endpoints + capabilities are FEATURE-DETECTED
 * from `/.well-known/openid-configuration` rather than hardcoded, so an additive
 * hub change (e.g. refresh tokens) never breaks us silently.
 */
export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

interface CacheEntry {
  discovery: OidcDiscovery;
  jwks: JWTVerifyGetKey;
  fetchedAtMs: number;
}

// Discovery is publicly cacheable and changes rarely; re-fetch hourly so an
// endpoint/capability change is picked up without hammering the hub. The JWKS
// set has its OWN short-lived cache (jose honours the JWKS Cache-Control, ≤5min)
// so a break-glass key rotation reaches us promptly regardless of this TTL.
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

const cacheByIssuer = new Map<string, CacheEntry>();

/**
 * Resolve (and memoise) the hub's discovery document + a JWKS key resolver for
 * an issuer. The `clock` is injectable so tests can exercise TTL expiry without
 * real time.
 *
 * @throws if discovery cannot be fetched or is missing a required endpoint.
 */
export async function getDiscovery(
  issuer: string,
  clock: () => number = Date.now,
): Promise<CacheEntry> {
  const cached = cacheByIssuer.get(issuer);
  if (cached && clock() - cached.fetchedAtMs < DISCOVERY_TTL_MS) return cached;

  const url = `${issuer}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: ${res.status} ${res.statusText}`);
  }
  const discovery = (await res.json()) as OidcDiscovery;

  for (const key of [
    "issuer",
    "authorization_endpoint",
    "token_endpoint",
    "jwks_uri",
  ] as const) {
    if (!discovery[key]) {
      throw new Error(`OIDC discovery missing required field: ${key}`);
    }
  }

  const entry: CacheEntry = {
    discovery,
    jwks: createRemoteJWKSet(new URL(discovery.jwks_uri)),
    fetchedAtMs: clock(),
  };
  cacheByIssuer.set(issuer, entry);
  return entry;
}

/** Drop the memoised discovery/JWKS — test hook so entries don't leak across cases. */
export function clearDiscoveryCache(): void {
  cacheByIssuer.clear();
}
