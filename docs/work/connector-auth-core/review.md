# connector-auth-core — Review

Scope: all 6 plan.md tasks (Topic 1 of pythia-connector-protocol) — `apps/pythia/src/connectors/auth/{dualLinkCache,nonceStore,ephemeralKeyStore,gateMiddleware}.ts(+.test)`,
`apps/pythia/src/routes/connectorAuth.ts(+.test)`, `apps/pythia/src/stats/middleware.ts` (1-line
export), `apps/pythia/src/index.ts` (composition-root wiring). First-time review of freshly-built,
uncommitted work — a new authentication/access-control subsystem, so security and correctness were
weighted heavily throughout (correctness + security + conventions + tests lenses, 4-15 file tier).

## Round 1

### [CRITICAL] Connector-auth trust anchor read straight off the untrusted, externally-advertised hub pool
- **Where:** `apps/pythia/src/index.ts` (dualLinkCache's poll + readApolloPublicKeyForAuth)
- Both the on-chain active-dual-link check and the Apollo public-key read used `nodePool.pickReadPair()` — the hub-fed rotation — instead of the operator's own Upload-Pool nodes, unlike the sibling browser Link-verify flow (`connectorVerify.ts`'s `trustAnchorPair()`), which explicitly prefers the operator's own nodes for exactly this reason. A single dishonest hub-advertised node could forge both answers and mint a valid ephemeral secret for an account it doesn't own — a full auth bypass.
- **Verdict:** CONFIRMED.
- **Fix:** exported `trustAnchorPair` from `connectorVerify.ts`; both reads in `index.ts` now use it (Upload Pool first, hub pool only as fallback). Independently re-verified in round 2's terminal pass, tracing both call sites.

### [MEDIUM] `readActiveDualLinkAccounts` silently resolved to an empty set on malformed "success" chain data
- **Verdict:** CONFIRMED. **Fix:** now throws instead of defaulting to `[]`, matching its own documented fail-closed contract.

### [MEDIUM] Unhandled throw from the public-key read crashed the verify route to an unstructured 500
- **Verdict:** CONFIRMED. **Fix:** wrapped in try/catch, returns `502 { error: "verification temporarily unavailable" }`.

### [MEDIUM] No request-body size limit on the two headless auth routes
- **Verdict:** CONFIRMED. **Fix:** both routes wrapped in the same `bodyLimit` middleware `read.ts`/`poll.ts`/`send.ts` already use.

### [MEDIUM] Nonce-store eviction was a blind global FIFO — any account's nonce could be evicted by a flood against unrelated accounts
- **Verdict:** CONFIRMED. **Fix (round 1):** scoped eviction to the same account. **Refined in round 2 and round 3 — see below.**

### [MEDIUM] Test reached into `EphemeralKeyStore`'s private internals via an unsafe cast
- **Verdict:** CONFIRMED. **Fix:** removed; the property ("raw secret never returned") is already exercised by every other test's use of `resolve()`'s narrow public return type.

### [LOW] `splitDualLinkKey` had no length validation before slicing
- **Verdict:** CONFIRMED. **Fix:** the poll loop now skips (and logs) any key that isn't exactly the expected composite length.

### [LOW] `CONSUMER_HEADER`, Apollo-codepoint classification, and `APOLLO_ACCOUNT_LEN` each independently duplicated
- **Verdict:** CONFIRMED (3 separate findings, same class). **Fix:** all three now have one exported source of truth (`stats/middleware.ts`, `connectorVerify.ts`, `dualLinkCache.ts` respectively), imported elsewhere.

### [STYLISTIC] Headless nonce burned before signature verification, unlike the sibling browser flow (which burns only on success)
- **Verdict:** STYLISTIC — confirmed as real but a defensible, more conservative choice; traced the suggested reorder and found it would not reopen a replay/double-issuance window (Node's synchronous Map-based consume already prevents that). **Left as-is**, undecided by the user.

## Round 2 (terminal pass, full-scope) — found new gaps in round 1's own fixes

- **[HIGH] × 3 — missing test coverage** for round 1's new behaviors: `readActiveDualLinkAccounts`'s reject/skip paths, `connectorAuth.ts`'s new 502 catch path, and the per-account nonce eviction. All CONFIRMED, all fixed — 5 new tests added across `dualLinkCache.test.ts`, `connectorAuth.test.ts`, `nonceStore.test.ts`.
- **[MEDIUM] `pyth/meter.ts` independently duplicated `OPERATIONAL_PATH`/`CONSUMER_HEADER`** — a third file with the same duplication round 1 set out to eliminate, missed. CONFIRMED, fixed (now imports both).
- **[MEDIUM] × 2, merged — per-account nonce cap still exploitable**, found independently by both the security and correctness lenses (two attack framings of the same root gap): (a) an attacker can spread a flood across many synthesized fake accounts to hit the global `MAX_NONCES` cap; (b) more directly, an attacker who knows a victim's own public on-chain account name can flood *that* account specifically. CONFIRMED. **Fix applied in round 2:** changed the per-account cap from "evict oldest" to "reject new issuance" (`issue()` returns `null` at cap) to stop a flood from silently invalidating the victim's real in-flight nonce.
- **[STYLISTIC] `authBodyLimit` hoisted to a module-level const** rather than inlined at each route like sibling files — noted by the lens itself as no change needed. Left as-is.

## Round 3 (terminal pass, full-scope) — the round-2 fix itself had two problems

- **[HIGH] Gate middleware only recognized `EphemeralKeyStore`, silently 401-ing every pre-existing `ConnectorStore` (`pk_live_...`) connector.** A genuine functional regression: any already-registered admin connector sending its permanent key would now be hard-rejected before reaching the route handler. CONFIRMED.
  **Fix:** `connectorGateMiddleware` now checks both `EphemeralKeyStore.resolve()` and `ConnectorStore.nameForKey()`, accepting either. New regression test added (`gateMiddleware.test.ts`) proving a `ConnectorStore`-issued key still passes the gate.
- **[HIGH] Round 2's "reject at cap" fix converted a probabilistic nuisance into a deterministic, sustained denial-of-service.** Under evict-oldest, a same-account flood could invalidate a victim's specific in-flight nonce, but new issuance was never blocked — the victim could always retry. Under reject-at-cap, an attacker maintaining 5 outstanding nonces against a named victim's account (a handful of requests every ~14 minutes, forever) guarantees every one of the victim's own `/challenge` calls gets `429` for as long as the attacker sustains it — strictly worse for this specific attack shape. CONFIRMED.
  **Resolution:** this same underlying gap (unauthenticated nonce issuance + no rate limiting) had now been found in 3 consecutive rounds without converging on a clean fix — per the review skill's circuit breaker, stopped iterating rather than attempting a 4th novel mitigation. **Reverted to per-account evict-oldest** (round 1's original approach), with the trade-off explicitly documented in code (`nonceStore.ts`'s `MAX_NONCES_PER_ACCOUNT` doc comment lays out both policies considered and why evict-oldest — bounded, probabilistic annoyance — was kept over reject — unbounded, deterministic lockout). The cross-account isolation test was also strengthened per a tests-lens finding that the original version would have passed even under a regressed *global* (non-per-account) counter.
- **[MEDIUM] `public/app.js` independently redeclares the same Apollo codepoint classifiers.** CONFIRMED, but genuinely out of scope — pre-existing frontend code never touched by this topic's plan. **Captured to `docs/work/backlog.md`** rather than fixed here.

## Known, accepted residual limitation (explicitly not fixed — read before extending this system)

Nothing in this app has request-level rate limiting. `AuthNonceStore`'s per-account cap (evict-oldest)
bounds the *damage* of an unauthenticated flood against one account (a forced re-challenge, never a
permanent lockout) but does not prevent the flood itself, and a flood spread across many synthesized
accounts can still exhaust the global `MAX_NONCES` bound. Fully closing this requires real rate-limiting
or proof-of-work infrastructure that does not exist anywhere in this codebase today — assessed twice
(round 1 and round 3) as genuinely new, out-of-proportion infrastructure work for this topic, not an
oversight. Tracked as a follow-up, not `docs/work/backlog.md` (it's specific enough to warrant its own
topic if picked up — start from this review's round 3 entry for context).

## Verification (after the last edit)

- `npm test -w @ancientpantheon/pythia` → **476 passed (72 files)**.
- `tsc --noEmit` clean. `npm run build --workspace=@ancientpantheon/pythia` clean (only the
  pre-existing, unrelated CSS `@import`-order warning).
- Behavioral verification (Topic 1's own acceptance criteria, from `docs/work/pythia-connector-protocol/design.md`): a full headless challenge → sign → verify → ephemeral-secret round trip, TTL expiry, rejection of an inactive-dual-link account, gating on/off — all exercised by the test suite above; no separate manual run needed beyond the earlier T6 `curl` check (unaffected by rounds 2–3, which touched only `nonceStore.ts`/`gateMiddleware.ts`/`meter.ts`/tests, not the wiring T6 already verified live).

Rounds: 3. Round 1: 1 CRITICAL + 5 MEDIUM + 2 LOW fixed, 1 STYLISTIC left open. Round 2: 3 HIGH
(missing tests) + 1 MEDIUM (duplication) + 1 MEDIUM (nonce cap, first pass) fixed, 1 STYLISTIC left
open. Round 3: 1 HIGH (ConnectorStore regression) fixed, 1 HIGH (nonce-cap trade-off) resolved by
reverting to the lesser-risk policy per the circuit breaker rather than continuing to iterate, 1
MEDIUM (app.js duplication) captured to backlog as out-of-scope. Terminal state: full suite green,
typecheck/build clean, zero unresolved CONFIRMED findings within this topic's scope.

Two STYLISTIC findings remain open by the user's default (not applied, no objection recorded):
1. Headless nonce burned before signature verification (`connectorAuth.ts`, diverges from the browser flow's burn-on-success-only).
2. `authBodyLimit` hoisted to a module const rather than inlined per-route (`connectorAuth.ts`).
