# pythia-self-consumer — Design

Follow-on to `docs/work/pythia-connector-protocol/design.md` (which shipped as v2.3.0), revisiting
Decision 4 there ("Pythia's own self-referential connector: deferred... revisit once there's an
actual internal consumer of it"). Shaped in conversation with the user (2026-07-31); approved
direction, proceeding straight to build under a standing autonomous-work instruction — no separate
approval gate before planning.

## Problem

Every Pantheon automaton is defined as `Codex (keys+signing) + Pythia (reads) + Khronoton
(scheduling) + logic`, and is expected to integrate all three constructors the same way. Pythia
already has her own Khronoton engine and her own (bespoke) sealed-vault key storage, but has never
gone through her own connector protocol: no dual-Apollo identity, no `PythiaConnector`, no
`ApolloSigner`, no dependency on `@ancientpantheon/pythia-client`. She is not yet a complete
automaton by her own blueprint's definition — the user wants her to close that gap, at "the same
level of integration" any other automaton gets, with one carve-out: the *data movement itself*
(the literal transport under `read`/`send`/`poll`) should not hairpin out over the public internet
to reach herself, since she already **is** the read engine those calls would otherwise reach.

## Approach

**Four independent pieces, composed together:**

1. **Her own dual-Apollo identity.** Extend her existing bespoke sealed vault (`apps/pythia/src/
   codex/{vault,sealedStore}.ts`) to also hold Apollo key material — **two independent Apollo
   keypairs** (one used as her Standard `₱.` half, one as her Smart `Π.` half), each generated via
   `Apollo.generateRandom()` from `@ouronet/dalos-crypto/registry`. **These are two unrelated
   random keypairs, not one keypair's two address encodings** — `generateRandom()` happens to
   return both a `standardAddress` and `smartAddress` derived from the same scalar, but the
   on-chain `DualLink` model (verified against the live `PYTHIA.pact` module and this session's own
   Topics 1-2 build) pairs two **independently owned** accounts, exactly like any other consumer's
   pair. Using one call's two address forms as "the pair" would be a different, weaker construction
   than what every other consumer does — do not do this.
2. **Signing capability.** A new module mirroring `apolloVerify.ts`'s dynamic-import pattern
   (`import("@ouronet/dalos-crypto/registry")`), but calling `Apollo.sign(keyPair, message)`
   instead of `.verify`. Wrapped as an `ApolloSigner` (the interface `packages/pythia-client`
   already defines) for each of her two halves, reading the matching keypair back out of her sealed
   vault per signing call.
3. **The in-process transport shortcut.** A custom `fetchImpl` — used by every `PythiaConnector`/
   `PythiaClient` instance she constructs for herself — that dispatches directly to her own Hono
   `app.request(url, init)` instead of the real global `fetch`. This is the ONLY thing that's
   different from a real external consumer: the full connector-auth protocol logic still runs for
   real (real nonce issuance/consumption in `AuthNonceStore`, real `apolloVerify` signature check,
   real `EphemeralKeyStore` secret issuance, real `x-pythia-key` gate enforcement on subsequent
   calls) — only the literal network hop (DNS/TLS/socket) is skipped. Requires **zero changes** to
   the published `@ancientpantheon/pythia-client` package — the `fetchImpl` injection point already
   exists on both `PythiaClientOptions` and `PythiaConnectorOptions` precisely for this kind of
   seam.
4. **Composition + a periodic loop.** Two `PythiaConnector` instances (one per half — the protocol
   proves ownership per-individual-Apollo-account, not per-pair; `docs/work/
   connector-activation-resolver/design.md`'s pairing tracker needs an independent proof from each
   half before it can activate the link). A small interval loop (mirrors `UsageReporter`'s
   established `setInterval` + `start()`/`stop()` + `.unref()` shape) drives `ensureSecret()` on
   both periodically — cheap and harmless once active (an already-active account's `ensureSecret()`
   just returns/refreshes its cached secret with no wasted work). One combined `keyProvider()`-style
   function feeds whichever half currently reports `status: "active"` into a `PythiaClient`
   instance constructed for Pythia's own eventual internal use.

**Alternatives considered:**
- **One `PythiaConnector` "managing" both halves internally** — rejected: `PythiaConnectorOptions`
  is deliberately scoped to one Apollo account (matches the real per-account wire contract); faking
  a pair-level connector would either violate that contract or just be a thin wrapper around two
  real connectors, which is what's built directly instead.
- **Auto-fund and auto-submit the on-chain `C_DeployApolloPythiaApiKey`/`C_LinkDualApiKey` txs
  herself** — rejected per the user's explicit call: this is a real-money action (500 STOA × 2), and
  confirmed via code research that Pythia has **no existing self-funded owner-account** anywhere
  (her only signing key today is the Khronoton flush key, operator-seeded, not self-provisioned).
  Building STOA-payment automation is real new infrastructure, out of proportion to this topic, and
  explicitly not what the user asked for ("that i would activate manually").
- **Bake self-detection into the published `pythia-client` package** (considered earlier in
  conversation) — rejected: fragile, adds risk to code every other consumer also depends on, and
  the existing `fetchImpl` seam already solves it with zero package changes.

## What ships automated vs. what stays manual

**Automated (this topic builds it, ready the moment the user deploys):**
- Idempotent self-keypair generation (once — a re-trigger is a safe no-op) + sealed storage.
- Full `ApolloSigner`/`PythiaConnector` wiring, in-process transport, periodic refresh loop.
- Once BOTH halves are deployed+linked on-chain (see below) and their proofs land, everything from
  "prove ownership" through "get a live ephemeral secret" happens with **zero further manual
  steps** — this is the exact same automatic pairing→activation path Topic 2 already built for any
  other consumer (`dual-link-activate` Khronoton resolver), exercised for real against Pythia's own
  two accounts.
- `@ancientpantheon/pythia-client` becomes a real runtime dependency of `apps/pythia`, and
  `admin/organVersions.ts` gains a third `ORGAN_PACKAGES` entry — she shows up as her own third
  constructor in her own Update & Deploy panel from this version onward.

**Manual (the user does this, after deploying the new version):**
- Generating the keypair (one click / one admin call — see Acceptance Criteria) IS automated, but
  the on-chain `C_DeployApolloPythiaApiKey` (×2, 500 STOA each) and `C_LinkDualApiKey` transactions
  that actually register + link the resulting public keys are **not** — the user submits those
  themselves (same as any human operator would, via whatever tooling already exists for a person to
  do this), using the public account strings the new admin surface displays. Once submitted, no
  further manual step is needed — the automated proof/activation loop takes it from there.

## Acceptance criteria

- [ ] A new admin-gated route generates Pythia's own Standard + Smart Apollo keypairs (two
      independent `Apollo.generateRandom()` calls), seals both into her existing vault, and is
      idempotent — calling it again after generation is a safe no-op, never regenerates/overwrites.
- [ ] A new admin-gated route (or the same one) returns her current self-connector status: both
      public account strings, whether each is generated, and — once wired — each connector's
      `ensureSecret()` status (`pending`/`active`/not-yet-attempted).
- [ ] The admin UI (`admin.html`/`admin.js`) surfaces this status somewhere visible, so the public
      account strings are easy to find/copy for the manual on-chain step.
- [ ] Signing: given a generated keypair and a challenge (`nonce`+`rp`), the new sign-side module
      produces a signature `apolloVerify` (the existing verify-side code) independently confirms
      valid — a real, round-trip-tested crypto proof, not a mocked assertion.
- [ ] The in-process `fetchImpl` shortcut: a request driven through it reaches Pythia's real route
      handlers (asserted by observing real side effects — e.g. a real nonce consumed in
      `AuthNonceStore`, a real secret issued by `EphemeralKeyStore`) with no real socket/DNS/TLS
      involved — verified by a test that fails if a real `fetch` is ever invoked.
- [ ] End-to-end (test double simulating "already linked on-chain" via an injected active-set, same
      pattern Topic 1's own acceptance criteria used): both of Pythia's own connectors independently
      complete challenge → sign → verify and, once both report proven, Topic 2's real
      `PendingActivationTracker`/`dual-link-activate` resolver picks up the pairing exactly as it
      would for any other consumer — no self-case branching anywhere in Topic 1/2's code.
- [ ] `apps/pythia/package.json` depends on `@ancientpantheon/pythia-client`; `admin/
      organVersions.ts`'s `ORGAN_PACKAGES` lists it as a third entry; her own Update & Deploy panel
      (verified via `collectOrganVersions()`'s own test coverage extended, not manually) now reports
      three constructor rows.
- [ ] Full existing test suite stays green; new code has real behavioral tests, not
      implementation-detail assertions. Version bump + CHANGELOG entry, following the same
      `docs/RELEASING.md` procedure Topics 1-3 already used.

## Out of scope

- Actually submitting the on-chain deploy/link transactions (manual, see above).
- The `pythia-cronoton-keyset` on-chain re-pointing (a separate, already-known blocker on the
  activation resolver actually firing for ANY consumer — unrelated to this topic).
- Any change to the published `@ancientpantheon/pythia-client` package itself.
- Any *other* part of Pythia's own runtime actually switching to call her gateway through the new
  self-`PythiaClient`/`PythiaConnector` wiring — none exists today (confirmed: nothing in
  `apps/pythia/src` currently imports `pythia-client` or calls her own routes internally), and
  inventing an internal consumer for it is not this topic's job. The wiring is built, real, and
  provably works — using it for something is a future decision.
- A refresh/poll cadence different from `pythia-client`'s existing defaults. Raised in conversation
  (e.g. a longer interval given the low cost of an in-process call) but no concrete reason to
  deviate ever landed — defaults stay defaults.
