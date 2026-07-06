import { jwtVerify, type JWTVerifyGetKey } from "jose";

/** The verified identity Pythia keeps from an `id_token`. */
export interface AdminIdentity {
  /** Opaque stable subject — the ONLY safe local user key (MUST #5). */
  sub: string;
  /** Role set from the token (MUST #6) — treated as a set, unknowns ignored. */
  roles: string[];
  /** Display-only, mutable — never a user key. */
  email?: string;
  /** Best available human-readable label (display_name → preferred_username →
   * name → a short sub fallback). Display-only, mutable. */
  displayName: string;
}

/** Pick the friendliest display label the token offers, falling back to sub. */
function pickDisplayName(payload: Record<string, unknown>, sub: string): string {
  for (const claim of ["display_name", "preferred_username", "name"] as const) {
    const v = payload[claim];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return sub.length > 10 ? `${sub.slice(0, 10)}…` : sub;
}

/** The top admin tier. The gate on `/admin` requires exactly this (contract §7). */
export const ANCIENT_ROLE = "ancient";

/**
 * Verify a hub `id_token` against EVERY pin the integration contract (§6)
 * mandates, then return the identity. Non-negotiable and all enforced here:
 *
 * - `algorithms: ['RS256']` — never trusts the token's own `alg`; this alone
 *   excludes `alg:none` and an HS256 token forged on the published RSA public
 *   key (MUST #1, #2).
 * - pinned `issuer` + pinned `audience` (our `clientId`) — rejects a token
 *   minted for a different client (MUST #3).
 * - `nonce` equals the exact value we sent on `/authorize` (MUST #4) — bound via
 *   the signed login-state cookie; `jwtVerify` does NOT check this itself.
 * - `clockTolerance: 60s` leeway for skew (MUST #7).
 *
 * @throws if any pin fails — the caller treats a throw as an auth denial.
 */
export async function verifyIdToken(
  idToken: string,
  opts: {
    jwks: JWTVerifyGetKey;
    issuer: string;
    clientId: string;
    expectedNonce: string;
  },
): Promise<AdminIdentity> {
  const { payload } = await jwtVerify(idToken, opts.jwks, {
    issuer: opts.issuer,
    audience: opts.clientId,
    algorithms: ["RS256"],
    clockTolerance: 60,
  });

  if (typeof payload.nonce !== "string" || payload.nonce !== opts.expectedNonce) {
    throw new Error("id_token nonce mismatch");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("id_token missing sub");
  }

  // `roles` is an ARRAY (MUST #6). Keep only string entries; ignore anything
  // unrecognized rather than switch-exhaustively on it.
  const roles = Array.isArray(payload.roles)
    ? payload.roles.filter((r): r is string => typeof r === "string")
    : [];

  const identity: AdminIdentity = {
    sub: payload.sub,
    roles,
    displayName: pickDisplayName(payload as Record<string, unknown>, payload.sub),
  };
  if (typeof payload.email === "string") identity.email = payload.email;
  return identity;
}

/**
 * The ancient-admin gate expression (contract §7): the connector-manager admits
 * ONLY the top `ancient` tier. `operator` (the display rewrite of the hub's
 * internal `client` role) and every lower tier are NOT admins and must not pass.
 */
export function hasAncientRole(roles: readonly string[]): boolean {
  return roles.includes(ANCIENT_ROLE);
}
