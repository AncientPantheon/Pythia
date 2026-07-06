import { SignJWT, jwtVerify } from "jose";

/**
 * Pythia's OWN cookie signing — HS256 over `PYTHIA_SESSION_SECRET`. This is
 * unrelated to the hub's RS256 id_token; it protects two first-party cookies:
 *
 * - the TRANSIENT login-state (`purpose: "login"`) carrying `state` + `nonce` +
 *   PKCE `codeVerifier` across the `/authorize` round-trip, and
 * - the post-login SESSION (`purpose: "session"`) carrying `sub` + `roles`.
 *
 * Both are signed so a tampered/forged cookie is rejected, and both carry an
 * `exp` so they self-expire. The `purpose` claim keeps the two from being
 * interchanged.
 */
export const LOGIN_COOKIE = "pythia_admin_login";
export const SESSION_COOKIE = "pythia_admin_session";

/** Transient state persisted across the redirect to the hub and back. */
export interface LoginState {
  purpose: "login";
  state: string;
  nonce: string;
  codeVerifier: string;
}

/** The authenticated session Pythia keeps after a successful login. */
export interface SessionState {
  purpose: "session";
  sub: string;
  roles: string[];
  /** Human-readable label for the header (display_name/username/…). */
  name: string;
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** Sign an arbitrary cookie payload with an absolute `exp` `ttlSeconds` out. */
async function signCookie(
  payload: Record<string, unknown>,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key(secret));
}

/** Verify + decode a cookie; returns `null` on any signature/expiry failure. */
async function verifyCookie<T>(
  token: string | undefined,
  secret: string,
): Promise<T | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      algorithms: ["HS256"],
    });
    return payload as T;
  } catch {
    return null;
  }
}

// Login round-trips are short; 10 minutes is ample and bounds how long a stale
// challenge cookie is accepted.
const LOGIN_TTL_SECONDS = 10 * 60;
// The admin session; re-login is cheap (Pythia holds its own session, so an
// expiry just re-bounces through `/authorize`).
const SESSION_TTL_SECONDS = 8 * 60 * 60;

export function signLoginState(
  state: Omit<LoginState, "purpose">,
  secret: string,
): Promise<string> {
  return signCookie({ ...state, purpose: "login" }, secret, LOGIN_TTL_SECONDS);
}

export async function readLoginState(
  token: string | undefined,
  secret: string,
): Promise<LoginState | null> {
  const payload = await verifyCookie<LoginState>(token, secret);
  return payload?.purpose === "login" ? payload : null;
}

export function signSession(
  session: Omit<SessionState, "purpose">,
  secret: string,
): Promise<string> {
  return signCookie(
    { ...session, purpose: "session" },
    secret,
    SESSION_TTL_SECONDS,
  );
}

export async function readSession(
  token: string | undefined,
  secret: string,
): Promise<SessionState | null> {
  const payload = await verifyCookie<SessionState>(token, secret);
  return payload?.purpose === "session" ? payload : null;
}
