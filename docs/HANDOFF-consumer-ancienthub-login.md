# Handoff: Implement "Login with AncientHub" in a consumer (the proven recipe)

**Audience:** any AncientHoldings app that needs hub-account login + role gating
(OuronetUI, Codex admin, future apps).
**Status:** this is the **battle-tested** recipe — Pythia is the first consumer to
run the full flow live, and this doc folds in every fix we hit along the way (the
hub's own contract doc, `2026-07-05-ancienthub-oidc-sso/HANDOFF-pythia-sso.md`, is
the authoritative *contract*, but is Pythia-specific and predates these
implementation fixes).
**Reference implementation:** `Pythia/apps/pythia/src/admin/` — copy it; it works.

---

## 0. What login is (and isn't)

- Hub login = **management identity** (who is the operator, what roles do they hold).
  It is delegated to the hub's OpenID Connect IdP at `https://ancientholdings.eu`.
- It is **not** the end-user wallet/Codex auth. A wallet app keeps wallet/key auth
  for users; hub login is the *operator* overlay that gates admin/settings actions.
- Gate admin actions on the **`ancient`** role. Any hub user may log in; only
  `ancient` may perform admin mutations.

---

## 1. Per-consumer prerequisites (one-time)

1. **Register the app as its own OIDC client with the hub** (a hub task — ask the
   hub agent). You receive:
   - `client_id` (stable slug/uuid)
   - `client_secret` (**shown once**; confidential — server-side only)
   - your `redirect_uri` registered **byte-for-byte** (e.g.
     `https://app.example/auth/callback`). The hub exact-matches it — a trailing
     slash or case difference fails at the first `/authorize`.
2. **Bootstrap env** (the irreducible minimum — cannot be runtime config, since you
   need it to log in): `OIDC_ISSUER=https://ancientholdings.eu`, `OIDC_CLIENT_ID`,
   `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, and a random `SESSION_SECRET` (≥32
   chars, e.g. `openssl rand -hex 32`). Keep secrets out of any public repo.

Everything else your app configures at runtime can live in a settings store.

---

## 2. The hub contract (feature-detect it; don't hardcode)

Fetch `${issuer}/.well-known/openid-configuration` and read endpoints + capabilities
from it. Current reality:

| Purpose | Method | URL |
| --- | --- | --- |
| Discovery | GET | `/.well-known/openid-configuration` |
| JWKS | GET | `/api/oidc/jwks` |
| Authorize | GET | `/api/oidc/authorize` |
| Token | POST | `/api/oidc/token` |
| Userinfo | GET | `/api/oidc/userinfo` |
| Logout | GET | `/api/oidc/logout` |

- **Auth-code + PKCE (S256)**, `response_type=code`, confidential client.
- **id_token is RS256**, validated statelessly against JWKS. **No refresh tokens,
  no introspection** — re-run `/authorize` when a token expires (cheap, since you
  hold your own session).
- **Role hierarchy:** `ancient > modern > baron > operator` (`operator` is the
  display rewrite of the internal `client` role; it is **not** an admin tier). Gate
  admin on `roles.includes("ancient")`. `roles` is an **array** — treat it as a set.
- Client auth at the token endpoint: **`client_secret_basic`** (HTTP Basic
  `Authorization: Basic base64(client_id:client_secret)`).

---

## 3. ⚠️ The fixes that aren't in the contract doc — read these first

These cost us real debugging time. Bake them in from the start.

### 3a. Don't let a trailing-slash redirect eat your POST body
**Hub status:** the hub is being fixed to serve its OIDC endpoints at the URLs
discovery advertises (no trailing slash) **without** redirecting POSTs — so a normal
`fetch` to `POST /api/oidc/token` returns the real response directly. Once that fix
is confirmed live for your flow, no workaround is strictly needed.

**Why this section still exists:** historically `POST /api/oidc/token`
**308-redirected to `/api/oidc/token/`** (Next.js `trailingSlash: true`), and Node's
`fetch` auto-follows the 308 but **drops the POST body + Authorization header**
across it → empty request → "token exchange rejected" (it even surfaced as a 500).
**GET redirects (discovery, jwks, authorize) are harmless** — only a POST loses its
body.

**Recommendation: keep a defensive same-origin redirect-follow anyway.** It is a
no-op when there is no redirect, and it protects you if the fix hasn't reached your
environment yet, or if any *other* POST endpoint (now or future) redirects. This is
the helper that made it work when the redirect was live:

```js
// Follow same-origin redirects manually so method/body/auth survive a 307/308.
// A no-op when the endpoint doesn't redirect.
async function postForm(url, headers, body) {
  let target = url, res;
  for (let hop = 0; hop < 3; hop++) {
    res = await fetch(target, { method: "POST", headers, body, redirect: "manual" });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) break;
    target = new URL(loc, target).toString();
  }
  return res;
}
```

(If your stack isn't Node/undici, verify your HTTP client preserves the body across
307/308 — many don't.)

### 3b. Verify EVERY pin — a partial verify is an auth bypass
Use a real JOSE library (Pythia uses `jose`). Non-negotiable:
```js
const { payload } = await jwtVerify(idToken, JWKS, {
  issuer: OIDC_ISSUER,          // pinned
  audience: OIDC_CLIENT_ID,     // pinned to YOUR client — rejects cross-client tokens
  algorithms: ["RS256"],        // never trust the token's own alg; excludes alg:none + HS256 forgery
  clockTolerance: 60,           // seconds of skew
});
if (payload.nonce !== expectedNonce) throw new Error("nonce mismatch"); // jwtVerify does NOT check this
```
- **Key your user record on `sub`** (opaque, stable). `email`/`preferred_username`/
  `display_name` are mutable, display-only.
- Bind and check `state` (CSRF) and `nonce` (replay) to the request that started it.

### 3c. Cookie / session posture
- **Login-state cookie** (carries `state` + `nonce` + PKCE `code_verifier` across the
  round-trip): HttpOnly, Secure, **SameSite=Lax** (Lax so the top-level navigation
  back from the hub sends it), short TTL (~10 min), path scoped to your callback.
- **Session cookie** (after login): HttpOnly, Secure, SameSite=Lax, **`path=/`** so
  the whole site sees the login (header, gated APIs). SameSite=Lax also gives you
  CSRF protection — cross-site POSTs won't send it. Pythia signs both cookies with
  `SESSION_SECRET` (HS256) — the session is first-party, unrelated to the hub's RS256.

---

## 4. The flow (what to build)

1. `GET /auth/login` — mint `state`, `nonce`, PKCE `code_verifier`/`code_challenge`;
   store them in the signed login-state cookie; 302 to `authorization_endpoint` with
   `client_id`, `redirect_uri`, `response_type=code`, `scope=openid profile email roles`,
   `state`, `nonce`, `code_challenge`, `code_challenge_method=S256`.
   → If already logged into the hub, this returns **instantly** (silent SSO).
2. `GET /auth/callback` — read `code` + `state`; verify `state` == the cookie's;
   exchange the code (`postForm` from §3a, `client_secret_basic`, sending
   `code_verifier`); **verify the id_token** (§3b); set the site-wide session cookie;
   redirect home.
3. `GET /api/me` — returns `{ authenticated, sub, name, roles }` (or
   `{authenticated:false}`). Drives the header ("Signed in as … · role") and the
   enabled/disabled state of admin controls.
4. `GET /auth/logout` — clear the session cookie; redirect home.
5. **Gate** admin mutation routes with a middleware: read the session, `401` if none,
   `403` unless `roles.includes("ancient")`.

---

## 5. Reference files (copy from Pythia — it's proven and tested)

`Pythia/apps/pythia/src/admin/`:
- `oidcConfig.ts` — env → typed config; whole surface is optional if unconfigured.
- `pkce.ts` — `state`/`nonce`/PKCE S256 mint + derive.
- `discovery.ts` — cached discovery + `createRemoteJWKSet` (feature-detect).
- `idToken.ts` — the §3b verify with every pin + `hasAncientRole` + display-name pick.
- `session.ts` — signed login-state + session cookies (HS256), purpose-separated.
- `routes.ts` — `postForm` (§3a), the full login/callback/logout flow, `/api/me`,
  and the `ancient`-gated example (its connector CRUD).

Copy these near-verbatim; swap the route prefixes/labels for your app. They pass a
test suite (`*.test.ts` alongside) that mints a local RS256 key to exercise the
verify pins, HS256-forgery rejection, nonce/issuer/audience mismatch, and the
308-redirect body preservation — port those too.

---

## 6. Checklist

- [ ] Registered as an OIDC client; `client_id`/`client_secret`/`redirect_uri` set in bootstrap env.
- [ ] `SESSION_SECRET` (≥32 chars) in env.
- [ ] Discovery feature-detected; endpoints not hardcoded.
- [ ] Token POST uses **manual redirect follow** (§3a) + `client_secret_basic`.
- [ ] id_token verified with issuer + audience + `algorithms:['RS256']` + nonce; keyed on `sub`.
- [ ] Login-state + session cookies HttpOnly/Secure/SameSite=Lax; session `path=/`.
- [ ] `/api/me` drives the header; admin mutations gated on `roles.includes("ancient")`.
- [ ] Ported the verify + redirect tests.

With this handoff **plus** the Codex wiring handoff, an agent has what it needs to
add hub login + the Codex/Pythia connection surface to a consumer like OuronetUI.
