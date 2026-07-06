import type { Hono, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { OidcConfig } from "./oidcConfig.js";
import { getDiscovery } from "./discovery.js";
import { createLoginChallenge } from "./pkce.js";
import { verifyIdToken, hasAncientRole } from "./idToken.js";
import {
  LOGIN_COOKIE,
  SESSION_COOKIE,
  signLoginState,
  readLoginState,
  signSession,
  readSession,
  type SessionState,
} from "./session.js";

// The verified admin session is exposed to gated handlers via the Hono context.
declare module "hono" {
  interface ContextVariableMap {
    adminSession: SessionState;
  }
}

// First-party cookies are scoped to the admin surface, HTTPS-only, HttpOnly, and
// SameSite=Lax — Lax so the top-level navigation BACK from the hub carries the
// login-state cookie, while cross-site sub-requests do not.
const COOKIE_BASE = {
  path: "/admin",
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
} as const;

/**
 * POST a form, manually following same-origin redirects so the method, body, and
 * Authorization header SURVIVE. The hub runs Next.js with `trailingSlash: true`,
 * so `POST /api/oidc/token` gets a 308 to `/api/oidc/token/` — and Node's
 * auto-follow drops the body + auth across a 307/308, which the IdP then rejects.
 * Re-issuing the POST to the redirect target ourselves keeps them intact.
 */
export async function postForm(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<Response> {
  let target = url;
  let res!: Response;
  for (let hop = 0; hop < 3; hop++) {
    res = await fetch(target, { method: "POST", headers, body, redirect: "manual" });
    const location =
      res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) break;
    target = new URL(location, target).toString();
  }
  return res;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(
    title,
  )}</title><style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1.5rem;color:#e8e6f0;background:#12101c}code{color:#7fe7d9}a{color:#f5c542}</style></head><body>${body}</body></html>`;
}

/**
 * A reusable gate that admits ONLY an authenticated `ancient` admin. Absent a
 * valid session it bounces to `/admin/login`; authenticated-but-not-`ancient`
 * gets a 403. The verified session is stashed on the context as `adminSession`
 * for downstream handlers (the connector-manager increment).
 */
export function createAdminGate(cfg: OidcConfig): MiddlewareHandler {
  return async (c, next) => {
    const session = await readSession(getCookie(c, SESSION_COOKIE), cfg.sessionSecret);
    if (!session) return c.redirect("/admin/login", 302);
    if (!hasAncientRole(session.roles)) {
      return c.html(
        page(
          "Pythia Admin — access denied",
          `<h1>Access denied</h1><p>Your account (<code>${esc(
            session.sub,
          )}</code>) is authenticated but lacks the <code>ancient</code> role required for the connector manager.</p><p><a href="/admin/logout">Sign out</a></p>`,
        ),
        403,
      );
    }
    c.set("adminSession", session);
    return next();
  };
}

function adminHome(session: SessionState): string {
  return page(
    "Pythia Admin",
    `<h1>Pythia Admin</h1><p>Signed in as <code>${esc(
      session.sub,
    )}</code> — roles: <code>${esc(
      session.roles.join(", ") || "(none)",
    )}</code>.</p><p>Connector management arrives in the next increment. This page confirms the AncientHoldings SSO gate is live and admitting only the <code>ancient</code> tier.</p><p><a href="/admin/logout">Sign out</a></p>`,
  );
}

/**
 * Register the human admin surface + its OIDC login flow against the hub IdP.
 * Routes (all under `/admin`, registered before the static catch-all):
 *
 * - `GET /admin/login`    — mint PKCE/state/nonce, stash a signed login-state
 *   cookie, redirect to the hub `authorization_endpoint`.
 * - `GET /admin/callback` — verify `state`, exchange the `code` server-side,
 *   verify the `id_token` (all contract pins), gate on `ancient`, set a session.
 * - `GET /admin`          — the gated admin home.
 * - `GET /admin/logout`   — clear the local session.
 *
 * Only wired when {@link OidcConfig} is present, so the public gateway boots
 * unchanged with no SSO configured.
 */
export function registerAdmin(app: Hono, cfg: OidcConfig): void {
  const gate = createAdminGate(cfg);

  app.get("/admin/login", async (c) => {
    const { discovery } = await getDiscovery(cfg.issuer);
    const challenge = createLoginChallenge();

    setCookie(
      c,
      LOGIN_COOKIE,
      await signLoginState(
        {
          state: challenge.state,
          nonce: challenge.nonce,
          codeVerifier: challenge.codeVerifier,
        },
        cfg.sessionSecret,
      ),
      COOKIE_BASE,
    );

    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      response_type: "code",
      scope: "openid profile email roles",
      state: challenge.state,
      nonce: challenge.nonce,
      code_challenge: challenge.codeChallenge,
      code_challenge_method: "S256",
    });
    return c.redirect(`${discovery.authorization_endpoint}?${params}`, 302);
  });

  app.get("/admin/callback", async (c) => {
    const code = c.req.query("code");
    const returnedState = c.req.query("state");
    const login = await readLoginState(getCookie(c, LOGIN_COOKIE), cfg.sessionSecret);
    deleteCookie(c, LOGIN_COOKIE, COOKIE_BASE);

    if (!code || !returnedState || !login) {
      return c.html(page("Pythia Admin — login failed", "<h1>Login failed</h1><p>Missing or expired login request. <a href=\"/admin/login\">Try again</a>.</p>"), 400);
    }
    if (returnedState !== login.state) {
      return c.html(page("Pythia Admin — login failed", "<h1>Login failed</h1><p>State mismatch. <a href=\"/admin/login\">Try again</a>.</p>"), 400);
    }

    const { discovery, jwks } = await getDiscovery(cfg.issuer);

    // Confidential token exchange, server-to-server. client_secret_basic auth;
    // the PKCE code_verifier proves this is the same agent that began the login.
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
      code_verifier: login.codeVerifier,
    }).toString();
    const tokenRes = await postForm(
      discovery.token_endpoint,
      {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${basic}`,
        accept: "application/json",
      },
      tokenBody,
    );
    if (!tokenRes.ok) {
      const detail = await tokenRes.text().catch(() => "");
      console.error(
        `pythia admin: token exchange failed (${tokenRes.status}) ${detail.slice(0, 200)}`,
      );
      // A 5xx means the hub's own token endpoint errored while issuing the token;
      // Pythia's request was well-formed. Name it so the failure is actionable.
      const msg =
        tokenRes.status >= 500
          ? `The AncientHoldings hub's token endpoint returned HTTP ${tokenRes.status} while issuing the token. This is a hub-side error, not Pythia — the hub logs for /api/oidc/token hold the cause.`
          : `Token exchange rejected (HTTP ${tokenRes.status}).`;
      return c.html(
        page(
          "Pythia Admin — login failed",
          `<h1>Login failed</h1><p>${esc(msg)}</p><p><a href="/admin/login">Try again</a></p>`,
        ),
        502,
      );
    }
    const tokens = (await tokenRes.json()) as { id_token?: string };
    if (!tokens.id_token) {
      return c.html(page("Pythia Admin — login failed", "<h1>Login failed</h1><p>No id_token returned. <a href=\"/admin/login\">Try again</a>.</p>"), 502);
    }

    let identity;
    try {
      identity = await verifyIdToken(tokens.id_token, {
        jwks,
        issuer: cfg.issuer,
        clientId: cfg.clientId,
        expectedNonce: login.nonce,
      });
    } catch {
      return c.html(page("Pythia Admin — login failed", "<h1>Login failed</h1><p>Token verification failed. <a href=\"/admin/login\">Try again</a>.</p>"), 401);
    }

    setCookie(
      c,
      SESSION_COOKIE,
      await signSession({ sub: identity.sub, roles: identity.roles }, cfg.sessionSecret),
      COOKIE_BASE,
    );
    return c.redirect("/admin", 302);
  });

  app.get("/admin/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, COOKIE_BASE);
    return c.html(page("Pythia Admin — signed out", "<h1>Signed out</h1><p><a href=\"/admin/login\">Sign in again</a>.</p>"));
  });

  app.get("/admin", gate, (c) => {
    const session = c.get("adminSession") as SessionState;
    return c.html(adminHome(session));
  });
}
