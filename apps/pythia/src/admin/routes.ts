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
import type { ConnectorStore } from "../connectors/store.js";
import type { TxSenderStore } from "../txsenders/store.js";

// The verified admin session is exposed to gated handlers via the Hono context.
declare module "hono" {
  interface ContextVariableMap {
    adminSession: SessionState;
  }
}

// First-party cookies: HTTPS-only, HttpOnly, SameSite=Lax — Lax so the top-level
// navigation BACK from the hub carries the login-state cookie (and gives CSRF
// protection: cross-site POSTs don't send the session).
const SECURE_COOKIE = { httpOnly: true, secure: true, sameSite: "Lax" } as const;
// Login-state is only needed under /admin (set at /admin/login, read at callback).
const LOGIN_COOKIE_OPTS = { ...SECURE_COOKIE, path: "/admin" } as const;
// The session is read SITE-WIDE (header + gated APIs), so it lives at the root.
const SESSION_COOKIE_OPTS = { ...SECURE_COOKIE, path: "/" } as const;

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
 * A reusable JSON gate that admits ONLY an authenticated `ancient` admin — used
 * on the connector-management API. `401` when unauthenticated, `403` when
 * authenticated but not `ancient`. The verified session is stashed on the context
 * as `adminSession` for downstream handlers.
 */
export function createAdminGate(cfg: OidcConfig): MiddlewareHandler {
  return async (c, next) => {
    const rawCookie = getCookie(c, SESSION_COOKIE);
    const session = await readSession(rawCookie, cfg.sessionSecret);
    if (!session) {
      console.error(
        `pythia admin: gate 401 ${c.req.method} ${c.req.path} — session cookie ${rawCookie ? "present but invalid/expired" : "absent"}`,
      );
      return c.json({ error: "authentication required" }, 401);
    }
    if (!hasAncientRole(session.roles)) {
      console.error(
        `pythia admin: gate 403 ${c.req.path} — roles=[${session.roles.join(",")}]`,
      );
      return c.json({ error: "the ancient role is required" }, 403);
    }
    c.set("adminSession", session);
    return next();
  };
}

/**
 * Register the human admin surface + its OIDC login flow against the hub IdP.
 * Routes (all under `/admin`, registered before the static catch-all):
 *
 * - `GET /admin/login`    — mint PKCE/state/nonce, stash a signed login-state
 *   cookie, redirect to the hub `authorization_endpoint`.
 * - `GET /admin/callback` — verify `state`, exchange the `code` server-side,
 *   verify the `id_token` (all contract pins), set a SITE-WIDE session, home.
 * - `GET /admin/logout`   — clear the session, home.
 * - `GET /api/me`         — current session (public; drives the header).
 * - `GET/POST /admin/connectors[...]` — the `ancient`-gated connector manager.
 *
 * Login is open to ANY hub user; the `ancient` gate applies only to the
 * connector-mutation routes. Only wired when {@link OidcConfig} is present, so
 * the public gateway boots unchanged with no SSO configured.
 */
/** Status of the AncientHub read-node feed, surfaced to the admin UI. Never
 * carries the HMAC secret — only whether one is set. */
export interface HubAdminStatus {
  hubBaseUrl: string;
  secretSet: boolean;
  fromSettings: boolean;
  slots: number;
  /** A short masked hint of the set secret (e.g. `…a1b2`) for confirmation. Empty
   * when no secret is set. Never the full value. */
  secretMask: string;
  /** Feed liveness for the green/red bullet: did the last poll succeed? */
  feedOk: boolean;
  /** Last feed error (null when ok / unconfigured) — shown on the red bullet. */
  feedError: string | null;
  /** Pythia's public egress IP (to allowlist on the hub), or null until detected. */
  egressIp: string | null;
}

/** The runtime controls the `ancient`-gated "Hub feed" admin panel drives. */
export interface HubAdminControls {
  status(): HubAdminStatus;
  setConfig(
    hubBaseUrl: string | undefined,
    hmacSecret: string | undefined,
  ): Promise<HubAdminStatus>;
  refresh(): Promise<HubAdminStatus>;
  /** The full secret, for the ancient admin's explicit copy action, or null. */
  revealSecret(): string | null;
}

/** Optional admin subsystems wired when present. */
export interface AdminExtras {
  hubAdmin?: HubAdminControls;
  txSenders?: TxSenderStore;
}

export function registerAdmin(
  app: Hono,
  cfg: OidcConfig,
  store: ConnectorStore,
  extras: AdminExtras = {},
): void {
  const gate = createAdminGate(cfg);
  const { hubAdmin, txSenders } = extras;

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
      LOGIN_COOKIE_OPTS,
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
    deleteCookie(c, LOGIN_COOKIE, LOGIN_COOKIE_OPTS);

    if (!code || !returnedState || !login) {
      console.error(
        `pythia admin: callback missing ${!code ? "code " : ""}${!returnedState ? "state " : ""}${!login ? "login-cookie" : ""}`.trim(),
      );
      return c.html(page("Pythia Admin — login failed", "<h1>Login failed</h1><p>Missing or expired login request. <a href=\"/admin/login\">Try again</a>.</p>"), 400);
    }
    if (returnedState !== login.state) {
      console.error("pythia admin: callback state mismatch");
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
      console.error("pythia admin: token response carried no id_token");
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
    } catch (err) {
      console.error(
        `pythia admin: id_token verification failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      return c.html(page("Pythia Admin — login failed", "<h1>Login failed</h1><p>Token verification failed. <a href=\"/admin/login\">Try again</a>.</p>"), 401);
    }

    setCookie(
      c,
      SESSION_COOKIE,
      await signSession(
        { sub: identity.sub, roles: identity.roles, name: identity.displayName },
        cfg.sessionSecret,
      ),
      SESSION_COOKIE_OPTS,
    );
    // Back to the site — the header now reflects the logged-in identity.
    return c.redirect("/", 302);
  });

  app.get("/admin/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, SESSION_COOKIE_OPTS);
    return c.redirect("/", 302);
  });

  // Public: who (if anyone) is logged in — drives the site header + the enabled
  // state of the "Add a new Connector" control. No secrets, just identity+roles.
  app.get("/api/me", async (c) => {
    const session = await readSession(getCookie(c, SESSION_COOKIE), cfg.sessionSecret);
    // Never cache the auth state — a stale cached "authenticated" would show the
    // UI as logged-in while the live session is already gone (phantom login).
    c.header("Cache-Control", "no-store");
    if (!session) return c.json({ authenticated: false });
    return c.json({
      authenticated: true,
      sub: session.sub,
      name: session.name,
      roles: session.roles,
    });
  });

  // ── ancient-gated connector manager ──────────────────────────────────────
  app.get("/admin/connectors", gate, (c) => c.json({ connectors: store.list() }));

  app.post("/admin/connectors", gate, async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { name?: unknown; url?: unknown; logo?: unknown; isPublic?: unknown }
      | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const url = typeof body?.url === "string" ? body.url.trim() : "";
    const logoRaw = typeof body?.logo === "string" ? body.logo.trim() : "";
    if (!name || !url) {
      return c.json({ error: "name and url are required" }, 400);
    }
    const created = store.add({
      name,
      url,
      isPublic: body?.isPublic === true,
      ...(logoRaw ? { logo: logoRaw } : {}),
    });
    // The apiKey is returned ONCE here and never retrievable again.
    return c.json({ connector: created.view, apiKey: created.apiKey }, 201);
  });

  app.post("/admin/connectors/:id/revoke", gate, (c) => {
    const ok = store.revoke(c.req.param("id"));
    return c.json({ ok }, ok ? 200 : 404);
  });

  // ── ancient-gated hub-feed config (activate the node-pool feed from the UI) ──
  if (hubAdmin) {
    app.get("/admin/hub-config", gate, (c) => c.json(hubAdmin.status()));

    app.post("/admin/hub-config", gate, async (c) => {
      const body = (await c.req.json().catch(() => null)) as
        | { hubBaseUrl?: unknown; hmacSecret?: unknown }
        | null;
      const hubBaseUrl =
        typeof body?.hubBaseUrl === "string" ? body.hubBaseUrl : undefined;
      // The secret is write-only: accepted here, never returned by the GET.
      const hmacSecret =
        typeof body?.hmacSecret === "string" ? body.hmacSecret : undefined;
      return c.json(await hubAdmin.setConfig(hubBaseUrl, hmacSecret));
    });

    app.post("/admin/hub-config/refresh", gate, async (c) =>
      c.json(await hubAdmin.refresh()),
    );

    // Explicit reveal for the admin's copy button — the FULL secret, only on an
    // ancient-gated request (never returned by the default status GET).
    app.get("/admin/hub-config/secret", gate, (c) => {
      c.header("Cache-Control", "no-store");
      return c.json({ secret: hubAdmin.revealSecret() });
    });
  }

  // ── ancient-gated Upload Pool (dedicated signed-tx sender nodes) ─────────────
  if (txSenders) {
    app.get("/admin/tx-senders", gate, (c) =>
      c.json({ senders: txSenders.list() }),
    );

    app.post("/admin/tx-senders", gate, async (c) => {
      const body = (await c.req.json().catch(() => null)) as
        | { url?: unknown; label?: unknown }
        | null;
      const url = typeof body?.url === "string" ? body.url.trim() : "";
      const label = typeof body?.label === "string" ? body.label.trim() : "";
      if (!url) return c.json({ error: "url is required" }, 400);
      return c.json({ sender: txSenders.add({ url, label }) }, 201);
    });

    app.post("/admin/tx-senders/:id/enabled", gate, async (c) => {
      const body = (await c.req.json().catch(() => null)) as
        | { enabled?: unknown }
        | null;
      const ok = txSenders.setEnabled(c.req.param("id"), body?.enabled === true);
      return c.json({ ok }, ok ? 200 : 404);
    });

    app.delete("/admin/tx-senders/:id", gate, (c) => {
      const ok = txSenders.remove(c.req.param("id"));
      return c.json({ ok }, ok ? 200 : 404);
    });
  }
}
