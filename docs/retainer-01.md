# Retainer-01 — Pythia cross-session handoff

> **Purpose.** A self-contained brain-dump so a *fresh* Claude conversation can pick up Pythia work cold, with no dependence on chat history. Written 2026-07-13, at commit `5e5f4f6` (Pythia service **v1.6.0**, live). This is retainer **#01**; issue `retainer-02.md`, `-03`, … as work advances and this one goes stale. **When a fact here conflicts with the code or `git log`, the code wins** — this is a map, not the territory.
>
> **Secrets note:** this repo is **PUBLIC**. This file contains **no** secrets and must never contain any. Where a secret is needed, it says where it lives, not what it is.

---

## 0. What Pythia is (30-second orientation)

Pythia is the **keyless read/relay Constructor** of the **AncientPantheon** (the StoaChain / Kadena-chainweb ecosystem). It reads on-chain state and relays it to consumers; it **never writes, never signs, never holds a private key, never touches funds**. Think "read gateway + decode language for StoaChain," dogfooding its own read endpoint for its own UI.

- **Live:** https://pythia.ancientholdings.eu (Ionos VPS, Docker behind **Caddy**).
- **Repo:** this one (`D:\_Claude\AncientPantheon\Pythia`), branch `main`, remote `origin`. **Public.**
- **Stack:** Hono + `@hono/node-server`, Node 22, TypeScript (tsc, `tsconfig.build.json`), Vitest, npm-workspaces monorepo.
- **Sibling repos** (same `D:\_Claude\AncientPantheon\` root): **Mnemosyne** (`codex.ancientholdings.eu` — the reference "constructor-service" whose blueprint Pythia is now copying), **Codex** (`@ancientpantheon/codex` npm pkg — ships the verifier UI), **AncientHoldings/hub**, **OuronetUI/wallet**.

### The invariants (never break these)
1. **Keyless.** Pythia never signs and holds no private key. Enforced in CI by `keylessScanner.ts`, which bans submit/listen/pollOne/createClient/getFailoverClient, `@stoachain/stoa-core/{network,reads}` imports, dalos key-gen symbols (`generateRandom`/`generateFromSeedWords`/`BitString`/`Integer`/`Bitmap`), and dynamic `import()` of banned modules. If you add crypto, expect the scanner to fight you — that's intended.
2. **Fund-less.** Pythia never moves the 250 STOA activation fee or any asset. Payments are user→treasury on-chain, never through Pythia.
3. **The Apollo/DALOS private seed NEVER reaches Pythia.** All signing happens client-side (wallet/Codex key-vault). Pythia only *verifies* signatures with public data (`Apollo.verify`).
4. **No secrets in the repo.** HMAC secret + OIDC creds live in the deploy env-file `/opt/pythia/pythia.env` (root-only, 0600) on the VPS, or in gitignored `*.local.env` locally. Never commit them.
5. **Never mount the docker socket** into the Pythia container (least-privilege deploy — matters for the automaton work below).

---

## 1. Where we are right now (v1.6.0, live)

Tree is **clean**, branch `main`, last commit `5e5f4f6`. Everything below is committed, pushed, deployed, and live-verified.

Recent history (newest first):
```
5e5f4f6 feat(admin): dedicated /admin dashboard + admin-managed verifier registry   ← v1.6.0
5417cd6 refactor(connectors): generic Apollo-ownership verifier contract (/apollo-verify)
675ddbd feat(connectors): editable + remembered localhost port for the verifier picker
e78e04d dev(localhost): aggregator start path loads gitignored pythia.local.env (wires OIDC)
63ac3e6 chore: gitignore the local dev launcher (holds a localhost-only OIDC client)
e9a3efa refine(connectors): loading state while Pythia reads the chain
64ccc00 refine(ui): per-chain status medallions + visible disabled/enabled action buttons
f181fa7 chore: lock @stoachain/dalos-crypto (fixes npm ci in the Docker build)
64b5ccd feat(connectors): keyless Apollo-half ownership verification (unlocks Link)   ← v1.5.0
d14603d feat(connectors): on-chain consumer API keys read live through Pythia + wider layout  ← v1.4.0
```
246 tests green. Git tags exist only for the **client**: `v1.0.0`, `v1.0.1`, `v1.1.0` (see the version-model note in §5).

---

## 2. What we built across this session (the v1.4 → v1.6 arc)

### 2a. On-chain Connectors tab (v1.4.0)
The website **Connectors** tab was rebuilt to read **live on-chain state** from the `ouronet-ns.PYTHIA` module **through Pythia's own** `POST /stoachain/read` (dirty read → chainweb `/local`, response shape `{result:{status,data}}`) — keyless dogfooding, no new backend needed. Also widened the site `--maxw` 1080→**1536px** to match the Ouronet Explorer.

Two sub-tabs:
- **Full API Keys** — the dual-links, with All/Active/Inactive filter + search + pagination.
- **Register / Link halves** — two columns (Standard `₱.` left, Smart `Π.` right), each with search + pagination. **Link enables only when both selected halves are unlinked** (`counterpart === "|"`, the BAR sentinel). Selecting a half again toggles it off. Action bar is sticky at the top.

### 2b. Keyless Apollo-half ownership verification (v1.5.x)
The "prove you own both halves → Link unlocks" flow. **The single most important correction from this session:**

> **Halves are verified on their OWN Apollo curve (`₱.`/`Π.`), NOT via the owner Ouronet account (`Ѻ.`).** The `₱.` and `Π.` accounts each have their own Apollo curve on which the same verification pattern runs.

Pythia reads a half's Apollo pubkey via `(ouronet-ns.PYTHIA.UR_Public (read-string "acct"))` (account passed as env-`data`, injection-safe; returns the `6g.…` pubkey string matching the row's `public` field) and verifies with **`Apollo.verify(sig, message, pubkey)`** from **`@stoachain/dalos-crypto/registry`** (`id: dalos-apollo`, Schnorr v2, pure public-data → stays keyless; the package is on **public npm** at `@4.0.3`). **NOT** `gen1.verify`/`schnorrSign` (those are the Ouronet Genesis `Ѻ.` curve — wrong curve).

Backend lives in `apps/pythia/src/connectors/verify/*` + `routes/connectorVerify.ts`. A **4-lens adversarial review** verified it fails closed (no proven-without-valid-sig, no Pact injection, correct key binding, keyless holds), and hardened it: HMAC-signed session cookie (no fixation), per-half single-use consume (replay-safe), trust-anchor pubkey read prefers the operator's OWN Upload-Pool nodes.

> **⚠ Residual (documented in `readApolloPublicKey.ts`):** the pubkey read is still **single-node** (no quorum/SPV). Harden to N-of-M before wiring any on-chain Link tx. And **Link's on-chain action stays DEFERRED** — it will eventually trigger the HUB DALOS Automaton to submit the link tx, and that Automaton capability must be built first.

### 2c. Generic `/apollo-verify` contract (v1.5.x refactor)
The verifier was reframed from a "Pythia verifier" into a **generic Apollo-curve-ownership verifier** any consumer can reuse. The contract (byte-exact — the signer must match this):

- **Request:** `GET <verifierBase>/apollo-verify?accounts=<enc(₱.)>,<enc(Π.)>&challenge=<nonce>&rp=<rp>&callback=<url>`
- **Return:** `<callback>?challenge=<nonce>&proofs=<enc(JSON [{apollo,sig}])>`
- **Canonical message signed:** `Apollo ownership proof\napollo: <acct>\nnonce: <nonce>\nrp: <rp>` (built in `canonicalMessage.ts`; `RP = "pythia.ancientholdings.eu"`).

The Codex package (`@ancientpantheon/codex@0.6.0`) already ships a matching signer/UI (`ApolloVerifyView`, `signApolloOwnership.ts`) — contract byte-matches. Handoff spec: [docs/HANDOFF-apollo-ownership-verifier.md](HANDOFF-apollo-ownership-verifier.md).

### 2d. Dedicated `/admin` dashboard + admin-managed verifier registry (v1.6.0)
Verifiers are now **admin-curated, not hardcoded**. New:
- `apps/pythia/src/verifiers/store.ts` — `VerifierStore {id,label,baseUrl,enabled}`, **NOT seeded** (admins add them first). `baseUrl` normalized to an http(s) origin (drops path/query, rejects non-http(s)), deduped by origin, re-validated on load. Backed by `VERIFIERS_FILE=/data/verifiers.json`.
- Public `GET /api/verifiers` → enabled `{id,label,baseUrl}` only (no-store).
- Ancient-gated CRUD under `/admin/verifiers` (add / enable / remove).
- **`GET /admin` serves `apps/pythia/public/admin.html`** — a self-gating dashboard (`admin.js`, checks `/api/me` for `isAncient`, server-gates all mutations) with sub-tabs **Verifiers · Observation Pool · Upload Pool**. The hub-config + Upload-Pool admin **moved here** off the landing's old (now removed) "Hub feed" tab. Ancients get an **Admin** link in the top bar.

The Connectors **Verify** popup now reads `/api/verifiers` (empty until an admin adds one; it points the user to `/admin`) instead of the old hardcoded 5-location list.

**To run verification end-to-end today:** log into Pythia as ancient → **Admin → Verifiers** → add e.g. `Mnemosyne` / `https://codex.ancientholdings.eu` (or `http://localhost:3005` for local) → the Verify popup then offers it.

---

## 3. The domain model you'll keep needing

**On-chain module:** `ouronet-ns.PYTHIA` on **chain 0** (this diverged from an earlier `APIARY` handoff sketch — the live name is `PYTHIA`).

**A full API key = a dual-link:** a **Standard** (`₱.` = U+20B1, the PYTHIA side) Apollo half **linked to** a **Smart** (`Π.` = U+03A0, the CONSUMER side) Apollo half. You register each half, then pair two *unlinked* halves to mint the key.

**Tables & schemas:**
- `PYTHIA|T|ApiKeys` (schema `PYTHIA|S|ApiKey`): key = `apollo-account`; fields `public`, `counterpart` (= BAR `"|"` until linked, immutable once set), `owner-account`, `registered-at`, `updated-at`.
- `PYTHIA|T|DualLinks` (schema `PYTHIA|S|DualLink`): `dual-link-key`, `standard-apollo`, `smart-apollo`, `consumer-lane`, `iz-active`, `linked-at`, `updated-at`.

**Free read surface (all callable via `/local`):** `PYTHIA.URD_ListAllApiKeys`, `PYTHIA.URD_ListAllDualLinks`, `PYTHIA.URD_ListActiveDualLinks`, `PYTHIA.URD_ListInactiveDualLinks`, `PYTHIA.UR_ApiKeyBySlot(standard)`, `PYTHIA.UR_ApiKeyByConsumer(smart)`, `PYTHIA.UR_Public(apollo)` (returns `6g.…` pubkey), and `ouronet-ns.DPL-UR.URC_0031([apollo])` (batch props). **Time fields serialize as `{"timep":…}` OR `{"time":…}` — handle both.** Registration tx seen on-chain: `PYTHIA|C>DEPLOY-API-KEY`.

**Consumer-key model context** (the larger settled design this UI sits on): an activation flow with a 250-STOA paywall, `activated` flipped on-chain by the HUB Codex Cronoton, Pythia as off-chain Apollo verifier (Pact can't verify Apollo-curve sigs). Full detail + the 5 written per-repo handoffs are in [docs/PYTHIA-CONSUMER-KEY-MODEL.md](PYTHIA-CONSUMER-KEY-MODEL.md) and memory `pythia-consumer-key-model`.

---

## 4. Key file map (where things live)

```
apps/pythia/
  src/
    version.ts                         PYTHIA_VERSION = "1.6.0"  (→ /healthz + footer; bump per release)
    index.ts                           app wiring: instantiates verifierStore, registers routes, serves /admin
    connectors/verify/
      canonicalMessage.ts              buildChallengeMessage() + RP constant
      apolloVerify.ts                  Apollo.verify wrapper (dynamic-imports dalos-crypto/registry; fails closed)
      readApolloPublicKey.ts           reads UR_Public via a ReadPair  ⚠ single-node — harden to quorum
      store.ts                         VerifyStore: challenge + proven sets, TTL, single-use consumeHalf
    routes/
      connectorVerify.ts               POST /api/connectors/verify/start, GET /connectors/verify/callback, GET status
      verifiers.ts                     public GET /api/verifiers
    verifiers/store.ts                 VerifierStore (NOT seeded); normalizeBaseUrl()
    verifiers/store.test.ts            unit tests for the store
    admin/routes.ts                    ancient-gated CRUD incl. /admin/verifiers/*
  public/
    index.html                         landing (Hub-feed tab removed; --maxw 1536 in styles.css)
    app.js                             landing JS  ⚠ ~340 lines of DEAD hub/txsender fns still here — delete (KEEP wireSubtabs)
    admin.html / admin.js              the /admin dashboard (self-gates on /api/me; hub-config + tx-sender live here now)
  Dockerfile                           ENV VERIFIERS_FILE=/data/verifiers.json
  pythia.local.env                     GITIGNORED — localhost-only OIDC creds (pattern *.local.env)
packages/pythia-client/                the npm SDK @ancientpantheon/pythia-client (v1.1.0)
scripts/localhost-dev.mjs              npm run dev / aggregator Start — loads pythia.local.env into child env
.github/workflows/{ci.yml, publish.yml}  CI + npm client publish (publish is v*-tag-driven, tied to CLIENT version)
docs/                                  handoffs (see §7)
```

**Sibling-repo files that matter:**
- Mnemosyne `docs/handoffs/04-automaton-blueprint.md` — **the canonical blueprint** for the active project (§13 is Pythia-specific). READ IT FIRST when resuming the automaton work.
- Mnemosyne `.github/workflows/image.yml`, `tests/changelog-version.test.ts`, `Dockerfile`, `docker-compose.yml`, `deploy/host/*`, `app/admin/*`, `app/api/admin/deploy/*` — reference implementations to copy/adapt.
- Mnemosyne `app/apollo-verify/{page.tsx, ApolloVerifyMount.client.tsx, ApolloVerifyApp.tsx}` — **UNCOMMITTED in the Mnemosyne repo**; the `/apollo-verify` route for the first live verification test.
- Codex `packages/codex-ouronet/src/apollo-verify/{signApolloOwnership.ts, ApolloVerifyView.tsx}` — the shipped signer (contract byte-matches Pythia).

---

## 5. ▶ THE ACTIVE PROJECT — automaton / containerization (Phases 1→4), PAUSED at Phase 1

The owner wants Pythia rebuilt into a **Mnemosyne-shaped "constructor-service"** per `Mnemosyne/docs/handoffs/04-automaton-blueprint.md`. Pythia ships **two artifacts on one version**: the npm client `@ancientpantheon/pythia-client` **and** a container `ghcr.io/ancientpantheon/pythia`. It reuses the infra core (tokenless on-box Deploy §3, OIDC login §5 [already have], sealed own-creds §6, Hub-style card admin §9, versioning §10) and SKIPS the codex-UI/Khronoton organs. **"Embed a verifier" = the on-box Deploy rebuilds the container from source with the verifier baked into config.**

Owner chose **"do the whole sequence 1→4":**

1. **Versioned container publish + versioning gate.** Add `.github/workflows/image.yml` (copy Mnemosyne's: buildx → login ghcr with `GITHUB_TOKEN` → metadata-action semver+latest → build-push, `cache-from/to: type=gha`; swap `mnemosyne`→`pythia`, context `.`). Add the §10 gate: root `CHANGELOG.md` + `tests/changelog-version.test.ts` (pins `package.json` version === newest `## [x.y.z]` entry) + `docs/RELEASING.md`. ⚠ Org must allow Actions "Read and write" or ghcr push is denied; buildx MUST precede build-push for `type=gha` cache.
2. **Mnemosyne-style card admin.** Restructure the current sub-tabbed `/admin` into a landing with **a tile per function** + shared `AdminGate`. The Deploy tile + Verifiers tile live here.
3. **Embeddable verifiers (two-tier).** A checked-in `apps/pythia/config/verifiers.json` baked into the image (EMBEDDED, shown badged, read-only at runtime) + the runtime `/data` ones (existing `VerifierStore`). "Embed"/"update embedded" folds a working runtime verifier into the checked-in config at Deploy time. Merge both in the store; embedded ones win/labelled.
4. **On-box tokenless Deploy button (the big one).** Host **systemd path-unit deployer** (root: git pull → `docker build` → **blue-green swap** → reload) triggered by a spool file the container drops via `POST /api/admin/deploy` — **NEVER mount the docker socket.** SSE-stream the deployer log to the browser. **Pythia uses CADDY (not nginx)** — blue-green needs a Caddy upstream swap (admin API or config include + reload), adapting Mnemosyne's nginx pattern. Deploy-mode-aware (dev = npm + restart).
5. *(later)* §6 master-key seal Pythia's own creds (HMAC secret, API keys) in the volume + rotation.

### ⚠ OPEN DECISION — blocks Phase 1 (settle this FIRST on resume)
The two artifacts have **diverged versions**: client `@ancientpantheon/pythia-client` @ **1.1.0** (last git tag `v1.1.0`) vs service `apps/pythia` @ **1.6.0**; root `package.json` @ **0.0.0**. The blueprint §13 wants them **lockstep on one version per `v*` tag**. The existing `.github/workflows/publish.yml` is tied to the **client** version (fails unless tag == client version + client README/CHANGELOG parity). Two options:
- **(a) Unify** to one repo-wide version — client "jumps" 1.1.0 → unified number; both client and container publish on the same `v*` tag. Matches the blueprint.
- **(b) Keep separate lanes** — client on its own tags; container versioned on the service number via its own tag scheme. No jump, but two versioning tracks to maintain.

**Do not write `image.yml` until the owner picks (a) or (b).** This was the exact point of the pause.

Full detail lives in memory `pythia-automaton-containerization` (and is the authoritative running record for this project).

---

## 6. Open / pending items (independent of the automaton work)

1. **First live verification test — Mnemosyne.** Commit + deploy Mnemosyne's uncommitted `app/apollo-verify/` route, then in Pythia `/admin` add Mnemosyne (`https://codex.ancientholdings.eu`) as a verifier, then run the round-trip from the LIVE Pythia site. This is the first checkup; the other targets (wallet / devwallet / localhost OuronetUI / localhost Codex) follow.
2. **Dead-code cleanup (task chip spawned).** ~340 lines of old hub/txsender functions are dead-but-defined in `apps/pythia/public/app.js` (superseded by `admin.js`). Delete them — **KEEP `wireSubtabs`** (still used by the chain module).
3. **Verification hardening before on-chain Link.** `readApolloPublicKey.ts` is single-node; move to N-of-M quorum/SPV before wiring the real on-chain Link tx (which itself waits on the HUB DALOS Automaton link-tx capability).

---

## 7. Reference docs already in `docs/`

- `04-automaton-blueprint.md` — **in the Mnemosyne repo** (`Mnemosyne/docs/handoffs/`), not here; the canonical guide for §5's project.
- [HANDOFF-apollo-ownership-verifier.md](HANDOFF-apollo-ownership-verifier.md) — the generic `/apollo-verify` contract spec.
- [PYTHIA-CONSUMER-KEY-MODEL.md](PYTHIA-CONSUMER-KEY-MODEL.md) + [PYTHIA-CONSUMER-KEY-IMPLEMENTATION.md](PYTHIA-CONSUMER-KEY-IMPLEMENTATION.md) — the settled consumer-key design + Pythia-side plan.
- [HANDOFF-consumer-key-INTERFACES.md](HANDOFF-consumer-key-INTERFACES.md) — the authoritative interface-control doc (APIARY names, etc.).
- Other per-repo handoffs: `HANDOFF-pact-apollo-pythia-key-module.md`, `HANDOFF-hub-cronoton-activation.md`, `HANDOFF-ouronetui-apollo-pythia-key.md`, `HANDOFF-codex-pythia-key.md`, `HANDOFF-ancienthub-sso.md`, `HANDOFF-ancienthub-pythia-nodepool.md`, `HANDOFF-consumer-ancienthub-login.md`, `HANDOFF-pythia-side-buildout.md`.

**Memory files** (auto-loaded each session, at `C:\Users\bicam\.claude\projects\D---Claude-AncientPantheon-Pythia\memory\`): `pythia-automaton-containerization` (the active project's running record), `pythia-consumer-key-model` (the verification subsystem detail), `pythia-deployment`, `pythia-hub-integration`, `pythia-multisource-vision`, `pythia-self-contained-principle`, `pythia-owner-decides-completeness`, `aletheia-oracle`.

---

## 8. How to operate

**Local dev.** The LocalHost aggregator **Start** button (or `npm run dev` → `scripts/localhost-dev.mjs`) boots the local site and loads gitignored `apps/pythia/pythia.local.env` (localhost-only OIDC client, redirect `http://localhost:3006/admin/callback`) so admin SSO works locally. The secret persists (added once). ⚠ Background `npm run dev` processes I launch get cleaned up at turn boundaries — the owner runs it from their own terminal so it survives.

**Tests / build.** `npm test` (Vitest, 246 green). `npm run build` (tsc via `tsconfig.build.json`). The keyless scanner runs in CI — expect it to reject banned crypto/network symbols.

**Admin access.** Log into Pythia via OIDC as an `ancient` role → **Admin** link appears → `/admin`. All admin mutations are server-gated (client gating is convenience only).

**Deploy (today's method — build-on-VPS).** SSH to `root@pythia.ancientholdings.eu` with the dedicated key `~/.ssh/pythia_deploy_ed25519`, `git pull`, `docker build`, `docker run` behind Caddy with `--env-file /opt/pythia/pythia.env`, graceful `docker stop` for the old container. After deploy, verify `GET /healthz` shows the expected `version`. (Phase 4 above replaces this manual path with the on-box Deploy button.) Deploy detail is in memory `pythia-deployment`.

---

## 9. First actions when you resume

1. **Confirm the version-model decision** (§5, option a vs b) with the owner. Nothing in Phase 1 should be written before this — it was the reason for the pause.
2. Once decided, execute **Phase 1** (ghcr `image.yml` + `CHANGELOG.md` + `changelog-version.test.ts` + `docs/RELEASING.md`), reading `04-automaton-blueprint.md` §13/§10 first.
3. In parallel-track (independent), the owner may want the **Mnemosyne verification round-trip** (§6.1) — that only needs Mnemosyne's route committed + a verifier row added in `/admin`.
4. Keep the invariants in §0 in front of you at every step.

---

*End of retainer-01. Supersede with retainer-02 when the automaton project lands or the version decision is made.*
