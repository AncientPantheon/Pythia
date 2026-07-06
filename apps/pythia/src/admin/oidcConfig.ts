/**
 * Deploy-time configuration for the human admin surface's SSO gate.
 *
 * Pythia's `/admin` connector-manager is gated on the AncientHoldings hub's
 * OpenID Connect IdP (`ancientholdings.eu`). Every value here is a DEPLOY secret
 * read from the environment — never the checked-in (public) config — mirroring
 * how `PYTHIA_API_KEYS` is injected. The client is CONFIDENTIAL: the
 * `clientSecret` lives only on this server and is never sent to a browser.
 *
 * The whole admin surface is OPTIONAL: if the required env is absent the loader
 * returns `null` and the caller leaves the admin routes unregistered, so the
 * public keyless gateway still boots with no SSO configured (local dev, or a
 * deploy before the client credentials are issued).
 */
export interface OidcConfig {
  /** The IdP issuer — pinned as the `iss` claim and the discovery base. */
  issuer: string;
  /** Pythia's registered confidential client id (also the pinned `aud`). */
  clientId: string;
  /** The one-time confidential client secret. Server-side only. */
  clientSecret: string;
  /** The exact redirect URI registered with the hub (byte-for-byte match). */
  redirectUri: string;
  /** Secret used to sign Pythia's own session + transient login-state cookies. */
  sessionSecret: string;
}

const DEFAULT_ISSUER = "https://ancientholdings.eu";
const DEFAULT_REDIRECT_URI = "https://pythia.ancientholdings.eu/admin/callback";

/**
 * Build the OIDC admin config from the environment, or return `null` when the
 * admin surface is not configured. Required: `PYTHIA_OIDC_CLIENT_ID`,
 * `PYTHIA_OIDC_CLIENT_SECRET`, `PYTHIA_SESSION_SECRET`. Issuer + redirect URI
 * fall back to the known production values.
 *
 * @param env - the environment bag (injectable for tests); defaults to
 *   `process.env`.
 */
export function loadOidcConfig(
  env: NodeJS.ProcessEnv = process.env,
): OidcConfig | null {
  const clientId = env.PYTHIA_OIDC_CLIENT_ID?.trim();
  const clientSecret = env.PYTHIA_OIDC_CLIENT_SECRET?.trim();
  const sessionSecret = env.PYTHIA_SESSION_SECRET?.trim();

  // All three secrets must be present for the gate to function. Absent any of
  // them, the admin surface stays off rather than half-wired.
  if (!clientId || !clientSecret || !sessionSecret) return null;

  // A short session secret would weaken the HS256 cookie signature; require a
  // meaningful length so a misconfigured deploy fails loudly at boot.
  if (sessionSecret.length < 32) {
    throw new Error(
      "PYTHIA_SESSION_SECRET must be at least 32 characters for a safe cookie signature",
    );
  }

  return {
    issuer: (env.PYTHIA_OIDC_ISSUER?.trim() || DEFAULT_ISSUER).replace(
      /\/+$/,
      "",
    ),
    clientId,
    clientSecret,
    redirectUri: env.PYTHIA_OIDC_REDIRECT_URI?.trim() || DEFAULT_REDIRECT_URI,
    sessionSecret,
  };
}
