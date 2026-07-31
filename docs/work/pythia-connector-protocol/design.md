# pythia-connector-protocol — Design

Topic of the Pythia sovereign-automaton project (umbrella: `docs/work/pythia-sovereign-automaton/design.md`)
— this is the "consumer-key API activation" sovereign action, one of the two automaton
transaction types Pythia needs (the other, the ledger flush, already shipped in v2.1.0).

Companion doc: `constructors/Codex/docs/HANDOFF-pythia-autonomous-connector.md` — the Codex-side
work this design depends on (headless Apollo challenge signing). That handoff is self-contained
for a fresh Codex-repo session; this doc is self-contained for Pythia-repo work.

## Problem

Pythia's on-chain `PYTHIA.pact` module already supports the full dual-Apollo consumer-key
lifecycle — deploy a Standard/Smart half, link them into an inactive `DualLink` row, and
(Cronoton-gated) flip it active. None of the surrounding infrastructure exists yet: nothing issues
challenges, nothing verifies a caller autonomously and recurringly, nothing mints or checks a
usable request-time credential, and nothing on Pythia's side calls the activation transaction.
Without this, "activate a consumer's API key" is a phrase in a design doc, not a working feature —
and per the user, this is also the last piece standing between Pythia and functioning as an
automaton at all (the other sovereign action, the ledger flush, is fully built and just needs
operational activation, tracked separately).

## What's already confirmed reusable (do not rebuild)

- **Apollo signature verification**, off-chain: `apolloVerify(signature, message, publicKey)` (`apps/pythia/src/connectors/verify/apolloVerify.ts`) — dynamic import of `@ouronet/dalos-crypto/registry`'s `Apollo.verify`, fails closed.
- **The canonical challenge message format**: `buildChallengeMessage({apollo, nonce, rp})` (`apps/pythia/src/connectors/verify/canonicalMessage.ts`) — byte-exact contract with the Codex-side signer (see the Codex handoff). `RP = "pythia.ancientholdings.eu"`, `CHALLENGE_TTL_SECONDS = 15 * 60`.
- **On-chain Apollo public-key reads**: `readApolloPublicKey()` (`apps/pythia/src/connectors/verify/readApolloPublicKey.ts`) — keyless Pact local-read of `(ouronet-ns.PYTHIA.UR_Public ...)`.
- **The live on-chain module** (`PYTHIA.pact`, already deployed — verified directly, not from stale local checkout): `C_DeployApolloPythiaApiKey` (self-service, 500 STOA/half), `C_LinkDualApiKey(standard, smart, consumer-lane)` (both half-owners, no fee, creates an inactive `DualLink` row), `A_LinkDualApiKey(standard, smart)` (Cronoton-gated, flips `iz-active: true`, requires `C_Link` first — doc comment: *"Cronoton flips inactive dual row to active after off-chain Apollo proof"*). Also `URC_ActivatedSet`/`UR_ActiveDualLinkSet`-style reads exist specifically as a **cache-mirror surface for Pythia** — the module already anticipates Pythia polling this.
- **The periodic-loop pattern**: `UsageReporter` (`apps/pythia/src/stats/usageReporter.ts`) — `setInterval` + `start()`/`stop()` + `.unref()`, the established shape for "background thing on a timer," instantiated at the `index.ts` composition root. Use this shape for the ephemeral-secret sweeper.
- **The Khronoton signing path Pythia already has**, proven in production: `pythFlushResolver.ts` + `keyResolver.ts` — Pythia signs with a key held in her own Codex, guarded on-chain by `pythia-cronoton-keyset`. This is the template for how Pythia would sign `A_LinkDualApiKey` herself (see Decision 3).

## What's confirmed missing (net-new)

- Any bearer-secret issuance, session/TTL store, or headless (non-browser-cookie) challenge/verify route. The existing `connectorVerify.ts`/`verify/store.ts` flow is one-time, browser-cookie-bound, and only flips a boolean "proven" flag — it never mints a secret and isn't reusable as-is for recurring headless auth. A parallel store + route pair is needed.
- Any TTL/expiry concept on `ConnectorStore` — today's `pk_live_...` keys are permanent until manually revoked.
- Real request-gating on `x-pythia-key` — today it's attribution-only (usage/billing), never rejects a request.
- Any code that calls `A_LinkDualApiKey`/`A_Flush`-style consumer-key activation.
- The Codex-side autonomous signing capability (`autoSignApolloChallenge` or equivalent) — tracked in the companion Codex handoff, not this doc.

## Decisions

Resolved this session (recommended defaults — the user did not object; revisit any of these
before build if that's wrong):

1. **Access model: gate access.** A valid, unexpired ephemeral secret is required for the
   full/paid tier; callers without one fall to the existing unattributed "direct" bucket (today's
   behavior, unchanged for that bucket). Rationale: the on-chain economics (500 STOA per Apollo
   half, consumer-lane billing) only make sense if verified access is worth something — an
   unenforced gate makes the fee structure decorative.
2. **Refresh interval: 3 hours**, one global constant for v1. Not yet per-consumer-lane
   configurable — ship the simplest version; the `DualLink` schema has room to add a per-lane
   interval field later without a breaking migration if that turns out to be needed.
3. **On-chain activation signer: Pythia signs it herself, via the already-proven Khronoton/Codex
   path — not a new "delegate to Dalos" protocol.** *(This reverses an earlier in-conversation
   recommendation to delegate to Dalos — worth noting why: no code anywhere implements
   Pythia-to-Dalos delegation for this or any purpose; building it would be new, unspecified,
   cross-team protocol work with a system this repo has zero visibility into. Self-signing reuses
   100% proven infrastructure — the exact mechanism already live for the ledger flush — and is
   blocked on exactly one thing: the `pythia-cronoton-keyset` on-chain re-pointing from
   `dalos-automaton-guard` to a key in Pythia's own Codex. That's a chain governance action, not
   new code, and per earlier conversation may be something the user can action directly.)* This
   means: build the resolver/cronoton now, using the flush's proven pattern; it fires (and, per
   the Khronoton executor's documented "never throws" contract, fails cleanly rather than
   crashing) whether or not the keyset has been re-pointed yet — going live is then purely gated
   on that one external action, with zero further code changes needed once it happens.
4. **Pythia's own self-referential connector: deferred, out of scope for this build.** Not
   required for the core capability (activating *other* consumers doesn't depend on Pythia having
   her own dual-link) — revisit once there's an actual internal consumer of it.

## Architecture

Two repos, three pieces:

```
Consumer Automaton (e.g. Pythia herself, later others)      Pythia (this repo)              Chain
──────────────────────────────────────────────────────      ───────────────────              ─────
Codex: autoSignApolloChallenge()  ◄── companion handoff,
  Codex repo, not this doc

Scheduled loop (every 3h):
1. POST /connectors/auth/challenge ─────────────────────►  issue nonce (new headless store,
                                                              NOT the browser cookie store)
                                    ◄──────────────────── { nonce, rp, expiresAt }
2. autoSignApolloChallenge(account, nonce, rp)
   → { apollo, sig }
3. POST /connectors/auth/verify
   { apolloAccount, signature }    ─────────────────────►  apolloVerify() [reused as-is]
                                                             + check apolloAccount is part of
                                                               an ACTIVE DualLink (cached
                                                               on-chain read)
                                                             mint ephemeral secret, TTL 3h
                                    ◄──────────────────── { secret, expiresAt }
4. seal secret in own vault (automaton/02 pattern)
5. use `secret` as x-pythia-key for read/send/poll calls ─►  gate: reject/deprioritize if
                                                              missing/expired (Decision 1)
6. on expiry, repeat from step 1
```

Separately, once per NEW consumer (not on the recurring cycle): after their `C_Link` transaction
lands (both half-owners signed, inactive row created) and they pass one challenge/verify round,
Pythia's own Khronoton fires `A_LinkDualApiKey` (new resolver, modeled on `pythFlushResolver.ts`),
signed by Pythia's own Codex key, flipping the row active on-chain.

### New Pythia-side components

1. **Headless challenge/verify routes** — new files (suggest `apps/pythia/src/connectors/auth/`),
   parallel to (not touching) the existing browser Link-verify flow. Reuses `apolloVerify`,
   `buildChallengeMessage`, `readApolloPublicKey` as-is. New: a nonce store keyed by apollo-account
   with no cookie/session concept (headless callers have no browser session).
2. **On-chain active-dual-link cache mirror** — a small poller (pattern: `NodePool`'s hub-feed
   poll, or `UsageReporter`'s interval) that periodically reads the chain's active-`DualLink` set
   and caches it, so challenge issuance/verification never needs a live chain read per request.
3. **Ephemeral secret store** — new TTL-aware store (extend `ConnectorStore` or add a parallel
   store — open item below), with a sweep loop on the `UsageReporter` interval pattern.
4. **Request-gating change** to the `x-pythia-key` middleware (currently attribution-only) so a
   missing/expired/invalid key actually affects the response, per Decision 1.
5. **New Khronoton resolver + cronoton** for `A_LinkDualApiKey`, mirroring `pythFlushResolver.ts`
   structure exactly — registered the same way (`registerServerResolver`), created via the same
   admin Builder UI already proven generic and working.
6. *(Not this build, tracked separately)* the `pythia-cronoton-keyset` on-chain re-pointing.

## Acceptance criteria

- [ ] A consumer with an active on-chain `DualLink` can complete a full headless challenge → sign
      (via a test double simulating the Codex side) → verify → receive an ephemeral secret round
      trip, with no browser/cookie involved.
- [ ] The ephemeral secret expires after 3 hours (configurable constant) and stops working for
      gated requests after expiry.
- [ ] A consumer without a valid/active dual-link, or with an invalid signature, is rejected with
      a clear error — never silently issued a secret.
- [ ] Gating behavior (Decision 1) is real: a request with a missing/expired `x-pythia-key`
      measurably differs from one with a valid ephemeral secret (exact behavior — reject vs.
      deprioritize — to be pinned down in planning).
- [ ] The `A_LinkDualApiKey` resolver/cronoton exists, is wired the same way as the flush
      resolver, and — per the Khronoton "never throws" contract — fails cleanly (logged failed
      fire, no crash) when the signing key isn't yet authorized on-chain (i.e. before the keyset
      re-pointing lands), so this ships without being blocked on that external action.
- [ ] Full existing test suite stays green; new code has real behavioral tests (round-trip
      verify, TTL expiry, gating on/off), not implementation-detail assertions.

## Open items — pinned down during planning

- **Wire shapes**: `POST /connectors/auth/challenge` — body `{ apolloAccount }` → `{ nonce, rp, expiresAt }`. `POST /connectors/auth/verify` — body `{ apolloAccount, nonce, signature }` → `{ secret, expiresAt }` on success; `400` for an invalid/expired/replayed nonce, `403` when the account isn't part of an active on-chain `DualLink`, `401` when the signature fails `apolloVerify`.
- **Ephemeral secret storage: a new, separate store** (`EphemeralKeyStore`), not an extension of `ConnectorStore`. Rationale: `ConnectorStore` models admin-added, permanent, human-managed connectors — mixing in system-issued, TTL'd, machine-refreshed secrets would conflate two different lifecycles (and two different admin-UI stories) in one file.
- **Gating behavior, pinned**: no `x-pythia-key` header at all → unchanged, falls through to today's open/"direct" behavior (no regression for existing anonymous callers). A header IS present but resolves to nothing valid (unknown, expired, malformed) → reject with `401` — a caller actively claiming an identity that doesn't check out is a different case from an anonymous caller, and silently downgrading it would mask a broken/misconfigured consumer rather than surface it.
- **Cache cold-start**: the active-dual-link cache mirror starts empty and treats "empty" as "nothing verifiable yet," exactly like `NodePool` treats an empty hub-slot set — no special-cased boot state, first successful poll populates it, everything gates as "not active" until then (fails closed, never open).

## Topics

This design decomposes into three topics, planned and built in order — each is independently
shippable (its own commit / review pass), and later topics depend on earlier ones' interfaces
being locked, not just their code existing:

1. **`connector-auth-core`** — the server-side headless challenge/verify round trip, the
   ephemeral-secret store, the on-chain active-dual-link cache, and real request gating. This is
   the full authentication capability; it does not yet include *making* a new dual link active on
   chain (that needs Topic 2), so it's tested end-to-end with an injected/mocked active-set rather
   than a real activation. **Plan this topic first.**
2. **`connector-activation-resolver`** — the pending-activation queue + the new Khronoton resolver
   that actually signs and submits `A_LinkDualApiKey`, wired the same way as the existing flush
   resolver. Depends on Topic 1's verify route existing (to enqueue into) and its exact interfaces.
3. **`pythia-client-connector-sdk`** — the consumer-side `packages/pythia-client` module (HTTP
   orchestration only — calls challenge/sign/verify against injected signer + storage interfaces),
   package version bump, changelog, and publish. Depends on Topic 1's wire shapes being locked
   (the whole point of building it last is to build against a real, tested contract, not a
   moving target).

## Next step

Plan Topic 1 (`connector-auth-core`) via `nectar:plan`. Topics 2 and 3 get their own plan.md once
Topic 1 ships and review is clean.
