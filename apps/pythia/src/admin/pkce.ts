import { randomBytes, createHash } from "node:crypto";

/**
 * The per-login transient secrets bound across the `/authorize` round-trip.
 * `state` defends CSRF, `nonce` binds the `id_token` to this exact request, and
 * `codeVerifier` is the PKCE secret whose S256 hash was sent as the challenge.
 * All three are stashed in a signed, short-lived login-state cookie and checked
 * at the callback.
 */
export interface LoginChallenge {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
}

/** URL-safe base64 with no padding — the encoding PKCE + OIDC params require. */
function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/**
 * Mint a fresh set of login secrets for one `/authorize` redirect. `state` and
 * `nonce` are 16 random bytes each; the PKCE `codeVerifier` is 32 random bytes
 * (well within the 43–128 char spec range once base64url-encoded) and the
 * `codeChallenge` is its SHA-256 digest, base64url-encoded — the `S256` method.
 */
export function createLoginChallenge(): LoginChallenge {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(
    createHash("sha256").update(codeVerifier).digest(),
  );
  return {
    state: base64url(randomBytes(16)),
    nonce: base64url(randomBytes(16)),
    codeVerifier,
    codeChallenge,
  };
}

/**
 * Recompute the S256 challenge for a verifier — the relationship the IdP checks
 * at the token endpoint. Exposed so tests can assert
 * `deriveCodeChallenge(v) === challenge` without reaching into crypto details.
 */
export function deriveCodeChallenge(codeVerifier: string): string {
  return base64url(createHash("sha256").update(codeVerifier).digest());
}
