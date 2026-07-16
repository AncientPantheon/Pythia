# Pythia Constructor-Service — Design (project)

> Rebuild the live Pythia deployed service into a Mnemosyne-shaped **constructor-service**
> per `automatons/Mnemosyne/docs/handoffs/04-automaton-blueprint.md` (§13 + §1/§3/§5/§6/§9/§10).
> **Stack divergence:** the blueprint is Next.js/React; Pythia is **Hono + vanilla HTML/JS**.
> We adapt the *pattern*, not the files.

## Problem
Pythia is a "constructor-service": automatons **import** its npm client AND humans **operate**
its live deployed service. Today those two faces are half-formalized:
- The npm client (`@ancientpantheon/pythia-client` @ 1.1.0) and the service (`apps/pythia` @ 1.6.0)
  have **diverged versions**; the root `package.json` is `0.0.0`. Releases publish only the client.
- The container is **hand-built on the VPS** (`git pull` + `docker build` + `docker run` behind
  Caddy) with **no versioned image** in a registry and **no changelog/versioning gate**.
- The `/admin` surface is a **flat 3-sub-tab page**, not the Mnemosyne "tile per function" shape,
  and doesn't hold all operator functions.
- The verifier registry is **single-tier** (runtime `/data/verifiers.json` only) and **unseeded**,
  so a fresh container starts with zero verifiers and nothing is baked in.

## Approach
Adapt the Mnemosyne blueprint across **three independently-shippable topics**, deferring the two
heaviest infra pieces (on-box Deploy button, sealed-secrets vault) to follow-on rounds. Pythia's
container already serves the whole app incl. the website from `apps/pythia/public/`, so
"containerize" is largely done — the new work is the **release lane**, the **card admin**, and the
**two-tier verifier registry**.

**Alternatives considered:**
- *Big-bang rewrite* — rejected: high risk, and Pythia's container already works.
- *Full blueprint now (incl. Deploy button + sealed vault)* — rejected by owner (variant-one scope):
  defer the heavy host-side infra until the visible rebuild + verifier focus land.
- *[Chosen] incremental 3-topic core rebuild* — lowest risk, ships the owner's priorities
  (containerize + card admin, then verifiers) fastest.

**Localhost vs live segregation** (blueprint §4): localhost runs **non-container** via
`npm run dev` → `scripts/localhost-dev.mjs` (a different launch flow); only the **live** server
runs the Docker container behind Caddy. The Deploy path (when built later) is deploy-mode-aware.

## Acceptance criteria (project-level)
- [ ] One `v*` git tag publishes BOTH `@ancientpantheon/pythia-client` to npm AND
      `ghcr.io/ancientpantheon/pythia:<semver>` + `:latest`.
- [ ] Repo-wide version is unified to a single source of truth (client jumps `1.1.0 → 1.6.0`;
      root + service + `version.ts` agree); a changelog-version test fails any bump that lacks a
      matching top `CHANGELOG.md` entry.
- [ ] `/admin` renders as a Mnemosyne-style **tile landing** behind a shared **AdminGate** (owning
      the checking / login / not-authorized / ancient states), with every operator function
      reachable as a tile.
- [ ] Verifiers are **two-tier**: a baked-in `apps/pythia/config/verifiers.json` (embedded, badged,
      read-only at runtime) merged with runtime `/data` ones; an admin can add/enable/remove the
      runtime ones and the Connectors **Verify** popup offers all enabled verifiers.
- [ ] Localhost still boots non-container via `npm run dev`; live still runs the container behind
      Caddy; both keep the existing `/data`-volume persistence.
- [ ] The full test suite stays green throughout; the keyless invariant (CI `keylessScanner`) holds.

## Out of scope
- **On-box tokenless Deploy button** (host systemd path-unit deployer, Caddy blue-green swap,
  SSE-streamed logs) — follow-on topic. The **Deploy tile** may appear showing version status, but
  its rebuild backend is deferred.
- **Master-key sealed-secrets vault** (§6: libsodium-sealed HMAC secret / API keys / dual-key
  halves + rotation) — follow-on topic. The **Security tile** may appear as a placeholder.
- **Building the verifier SIGNING side** — the `/apollo-verify` (Apollo/DALOS) signing route lives
  on the verifier targets (a Mnemosyne/Codex the owner sets up), NOT in Pythia. Pythia only
  **registers + orchestrates** verifiers; the owner adds the targets.
- On-chain Link tx and the N-of-M quorum hardening of `readApolloPublicKey.ts`.
- The localhost port/OIDC reconciliation (:3009 vs the `:3006`-registered redirect) — a small fix
  handled when we touch local admin login, tracked in memory, not a project deliverable.

## Topics
1. **container-ci** — ✅ DONE (v1.7.0 released: npm + ghcr on one tag; versioning gate).
2. **card-admin** — ✅ DONE (tile landing + AdminGate + hash router; deployed live).
3. **admin-connectors-ia** — regroup the StoaChain-specific pools under a **Blockchain Connectors**
   section (landing → Connectors → StoaChain → Observation Pool + Upload Pool w/ visible seeds +
   the REAL routing rule-book displayed); restyle the landing to Mnemosyne-style **lined entries**;
   merge Version & Network into the Update & Deploy entry. Shaped now (owner-directed round).
4. **update-deploy** — the real on-box tokenless Deploy: spool + systemd path-unit + **blue-green
   zero-downtime swap via Caddy** (owner chose blue-green; both ports loopback-only, no firewall
   changes) + SSE-streamed log + a status panel depicting live color/port/container. Shaped next.
5. **security-vault** — master-key sealed operator creds (libsodium secretbox; seal the hub HMAC
   secret etc.), atomic env write, plan-then-apply rotation; the Security entry's real backend.
   ⚠ verify the keylessScanner tolerates symmetric sealing. Shaped after update-deploy.
6. **embeddable-verifiers** — two-tier verifier registry (baked-in `config/verifiers.json` +
   runtime `/data`) + embed flow. Owner deferred until after topics 3–5.
