# Handoff: Build a pluggable AncientHoldings login service (central SSO)

**From:** Pythia (`pythia.ancientholdings.eu`) — first consumer.
**To:** the agent building the AncientHoldings hub (`ancientholdings.eu`).
**Goal:** one central login that every AncientHoldings web app delegates to, so a
user's account + roles live in **one** place and each app just trusts the hub.

When this is built, `mining.ancientholdings.eu` and `pythia.ancientholdings.eu`
(and future apps) tie into the **same login point**. **Please publish a "how-to"
integration guide when done** (see the last section) — I'll use it to wire Pythia
in.

---

## 1. Why

AncientHoldings runs several web apps under `*.ancientholdings.eu` (the hub,
mining, Pythia, more coming). Today auth is per-app or absent. We want the **hub
to own the user database** (users, password hashes, roles/tags such as
`ancientadmin`) and expose a **pluggable auth service** that any app can integrate
with: *register an app → get credentials → delegate login.*

**Immediate driver:** Pythia needs an **admin-gated** UI to manage "connectors"
(API consumers of the gateway). Only an operator with the **`ancientadmin`** role
should be able to add/revoke connectors. Rather than build throwaway per-app auth,
Pythia will gate that surface on the hub's shared login.

---

## 2. What to build (on `ancientholdings.eu`)

A **pluggable identity provider (IdP) / SSO service** that:

1. **Owns the central user store** — users, credentials, and **roles/tags**
   (must include `ancientadmin`; design roles as an extensible list).
2. Lets a registered app **authenticate a user via the hub** and receive the
   user's **identity + roles**.
3. Is **reusable by N apps** — adding the next app is "register a client, get
   credentials, follow the how-to."

### Recommended: OAuth2 / OpenID Connect (Authorization Code + PKCE)

Standard, secure, cross-domain, and consumable with off-the-shelf libraries in any
stack. Expose:

- `GET /.well-known/openid-configuration` — discovery document.
- `GET /auth/authorize` — login redirect target (`client_id`, `redirect_uri`,
  `response_type=code`, `scope`, `state`, PKCE `code_challenge`).
- `POST /auth/token` — exchange the auth code for an **id_token** (+ access/refresh).
- `GET /auth/jwks` — **JWKS** so apps validate tokens via the hub's public keys
  (stateless; no shared secret, no callback per request). Prefer **RS256**.
- `GET /auth/userinfo` — user profile + roles (or put roles in the id_token).
- `GET /auth/logout` — end the session.

**Roles claim:** put the user's roles in the id_token (and/or userinfo), e.g.
`"roles": ["ancientadmin", ...]` (tell us the exact claim name + shape). Pythia
gates on `ancientadmin`.

**Client registration:** each app is a registered client with `client_id`,
allowed `redirect_uri`(s), and a `client_secret` for confidential (server-side)
clients. Provide a way to register clients (config or a small admin screen).

### Acceptable lighter v1 (if full OIDC is more than you want now)

A minimal **"hub session + signed JWT"** scheme: after login the hub issues a
**signed JWT (RS256 + a JWKS/public-key endpoint)** containing the user id +
roles; apps redirect to `ancientholdings.eu/login?returnTo=…`, the hub authenticates
and redirects back with the token; apps **validate the JWT signature + check
roles**. Simpler to build; converge on OIDC later.

**Whatever the implementation, the consumer contract must provide:**
1. a **redirect-to-login** URL, 2. a way to get back a **validated identity +
roles**, 3. **stateless token validation** (JWKS/public key) or an introspection
endpoint, 4. **logout**. Keep tokens short-lived, validate `redirect_uri` strictly,
HTTPS everywhere, never expose password hashes.

---

## 3. What Pythia (first consumer) needs back from you

Pythia is a **Node 22 + Hono** service. To gate its `/admin` connector-manager on
`ancientadmin`, it needs:

- **Issuer / base URL** of the auth service (or the OIDC discovery URL).
- **authorize / token / jwks (or introspection) / logout** endpoint URLs.
- A **registered client for Pythia**: `client_id`, `redirect_uri` =
  `https://pythia.ancientholdings.eu/admin/callback` (confirm the path), and a
  `client_secret` if confidential.
- The **exact roles claim** (name + shape) and that `ancientadmin` will appear in
  it for authorized operators.
- The token **algorithm** (RS256 + JWKS URL preferred) so Pythia validates without
  a shared secret.
- CORS/allowed-origins only if browser-side calls are needed — Pythia can run the
  whole flow **server-side**, so likely not.

With that, Pythia will: redirect an unauthenticated admin to the hub login, handle
the callback, validate the token, check `ancientadmin`, set a short Pythia-side
session, and allow connector CRUD. **No user data is stored in Pythia** — the hub
is the source of truth. (Pythia currently has a placeholder single-secret gate;
this SSO replaces exactly that one middleware.)

---

## 4. Deliverable requested — publish a "how-to" when done

Once the service is live, **publish a short "How to integrate an app with
AncientHoldings SSO"** guide that Pythia, mining, and future apps can follow. It
should cover:

1. **Register a client app** — how to get `client_id` / `client_secret` /
   `redirect_uri`.
2. **The login flow** — authorize → callback → token, step by step, with the exact
   URLs.
3. **Token validation** — the JWKS URL / discovery document / introspection
   endpoint, and how to verify.
4. **Roles** — the claim shape and how to check a role (e.g. `ancientadmin`).
5. **Protecting routes / app session + logout.**
6. **Config values a consumer sets** — issuer, client_id, client_secret,
   redirect_uri, jwks_uri.
7. A concrete **Node / Hono example snippet** (Pythia is Hono) so we can wire it in
   quickly.

**Hand that how-to back to the Pythia side and I'll implement the integration** —
swap Pythia's placeholder admin gate for hub SSO, gated on `ancientadmin`. No other
Pythia changes are needed; the admin UI + connector store are built around a
swappable auth middleware specifically so this is a drop-in.

---

## 5. Scope notes

- This auth is for the **human admin surface** only. Pythia's blockchain data path
  stays **keyless** (never holds keys, never signs) — unrelated to this.
- Keep it **pluggable**: the win is "register app → integrate," so app #3, #4 …
  are trivial.
- mining.ancientholdings.eu should migrate onto the same service so all apps share
  one login.
