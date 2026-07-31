# connector-activation-resolver — Review

Scope: all 5 plan.md tasks (Topic 2 of pythia-connector-protocol) —
`apps/pythia/src/connectors/auth/{readApolloCounterpart,pendingActivationTracker}.ts(+.test)`,
`apps/pythia/src/automaton/khronoton/dualLinkActivateResolver.ts(+.test)`,
`apps/pythia/src/routes/connectorAuth.ts(+.test)` (activation-tracker hook added this topic),
`apps/pythia/src/automaton/khronoton/register.ts`, `apps/pythia/src/server.ts`,
`apps/pythia/src/index.ts` (composition-root wiring). This topic pairs two independent per-half
headless ownership proofs into one ready-to-activate on-chain `DualLink` pair and hooks it behind
Topic 1's gate — security- and correctness-critical (it decides who gets a consumer API key
activated on-chain), so all rounds weighted correctness/security heavily.

## Round 1 — build-time self-review before first full-scope pass

- **[CRITICAL] Auth-bypass: a not-yet-active account could still receive a working ephemeral
  secret.** Root cause traced to this topic's own plan.md T4 wording instructing an unconditional
  `200 { secret, expiresAt }` response regardless of `isActiveAccount`. This completely defeated
  Topic 1's access-gating purpose — anyone who could sign a challenge for ANY Apollo account
  (not necessarily an active dual link) would receive a live secret. CONFIRMED.
  **Fix:** `connectorAuth.ts`'s verify handler now branches on `isActiveAccount` — a not-yet-active
  account is always turned away with `202` and no secret, however the pairing hook fires; the
  `200 { secret, expiresAt }` response path is reachable ONLY when `isActiveAccount` is true.
  2 existing tests rewritten to assert the fixed (202, no secret) shape.
- **[CRITICAL] Pact code-injection in `readApolloCounterpart.ts`.** The caller-influenced
  `apolloAccount` was interpolated directly into the executed Pact source string
  (`` `(...UR_Counterpart "${apolloAccount}")` ``), unlike the established, safe pattern already
  used by `readApolloPublicKey.ts` (env-`data` + `read-string`). A crafted account string
  containing `"` could close the string literal and inject arbitrary Pact source into a keyless
  local read. CONFIRMED. **Fix:** mirrors `readApolloPublicKey.ts` exactly — the account is passed
  via `buildLocalCommand(..., { data: { acct: apolloAccount } })` and the executed code is now a
  fixed literal, `(ouronet-ns.PYTHIA.UR_Counterpart (read-string "acct"))`. Regression test parses
  the actual outgoing request body and asserts the code string never contains the injection
  payload and is exactly the fixed literal.
- **[MEDIUM] Wiring-pattern violation.** `register.ts` imported the `pendingActivationTracker`
  singleton directly from `index.ts` rather than receiving it as a parameter, contradicting this
  resolver's own doc comment ("never a static import") and diverging from the sibling
  `pythFlushResolver`'s established wiring. CONFIRMED. **Fix:** `startPythiaKhronotonEngine`
  now takes the tracker as an explicit 3rd parameter, threaded from `server.ts` → `index.ts`'s
  single composition-root instance.

## Round 2 — HIGH map-key-collision + 2 LOW hardening findings

- **[HIGH] `pairKey()` map-key collision.** `PendingActivationTracker` originally keyed pending
  pairs with `[a, b].sort().join("|")` — collision-free ONLY if neither account can ever contain
  the separator `"|"`, which nothing guarantees about a chain-supplied `counterpart` string. Two
  genuinely different pairs (e.g. accounts `"A|B"`/`"C"` vs. `"A"`/`"B|C"`) could collide on the
  same joined text and silently corrupt each other's pending state. CONFIRMED.
  **Fix:** `pairKey()` now uses `JSON.stringify([a, b].sort())`, collision-free regardless of
  content. Kept `readApolloCounterpart.ts`'s shape validation (length + `₱`/`Π` prefix check on
  the returned counterpart) as defense-in-depth for garbage/malformed chain data, independent of
  the key fix. Regression test constructs the two colliding-under-naive-join pairs and proves they
  stay independent.
- **[LOW] No guard against a self-referential proof (`apolloAccount === counterpart`).**
  CONFIRMED — such a call could never transition to fully-proven (only one of `provenA`/`provenB`
  could ever be set) yet would silently occupy a map slot inertly until TTL sweep. **Fix:**
  `recordProof` now logs and ignores a self-referential call rather than storing it.
- **[LOW] No cap on total outstanding pending pairs.** CONFIRMED — mirrors `AuthNonceStore`'s
  `MAX_NONCES` bound, absent here. **Fix:** added `MAX_PENDING` (default 10,000, injectable via
  `maxPending` for testability), evicting only a NOT-yet-fully-proven entry when at capacity — a
  fully-proven, ready pair is never dropped to make room for a new half-proof.

## Round 3 — terminal full-scope pass (correctness / security / conventions / tests lenses)

- **[HIGH] Head-of-line blocking: a single permanently-stuck pending pair could starve every other
  ready pair for up to the full 24h TTL.** `beginActivation()` always selected the single
  globally-oldest fully-proven entry with no notion of "this one keeps failing, try the next."
  `commitActivation` — the only non-TTL removal path — fires only on confirmed on-chain success
  (`dualLinkActivateResolver.ts`'s `settle()`). A real, reachable trigger: `dualLinkCache` polls
  `isActiveAccount` only every ~60s, so a stale read can let `connectorAuth.ts`'s verify handler
  re-record a proof for a pair that's ALREADY active on-chain; that pair's on-chain
  `A_LinkDualApiKey` call then never meaningfully confirms, and it sits at the head of the queue
  blocking every other, unrelated, genuinely-pending consumer pair. Adversarially validated
  (CONFIRMED) — including checking whether this was an already-accepted pattern shared with the
  sibling `pythFlushResolver`; it is NOT, since that resolver operates on one continuously-growing
  batch with no per-item mutual blocking, unlike this tracker's explicit per-pair FIFO queue shape.
  **Fix:** added `ACTIVATION_STUCK_GRACE_MS` (10 minutes) and `firstOfferedAt` per-entry tracking.
  `beginActivation()` now prefers any "fresh" ready entry (never offered, or offered less than the
  grace period ago) over a "stuck" one (offered longer ago and still uncommitted); a stuck entry is
  never abandoned outright — it's still offered, and still committable, whenever it's the only
  ready candidate, so a transient failure that later succeeds is still picked up. 2 new tests:
  a stuck entry no longer blocks a fresher pair past the grace period (and both eventually drain);
  a stuck entry is still offered/committable when it's the only candidate.
- **[MEDIUM] × 4 — test-coverage gaps, none exploitable on their own but each would let a real
  regression slip through unnoticed:**
  1. No test proved the pairing hook's fire-and-forget contract — every existing test used a
     `readApolloCounterpart` that resolved immediately, so an accidental `await` added in front of
     the block (blocking the HTTP response on it) would still pass every test.
  2. No test exercised exactly ONE of the two optional deps (`readApolloCounterpart` /
     `pendingActivation`) being supplied without the other — only "both" and "neither" were
     tested, so a regression turning either `&&` into `||` in the gate would go undetected.
  3. No test exercised `readApolloCounterpart` resolving to `null` (a genuinely unlinked account)
     for a not-yet-active account — the only case actually preventing `recordProof` from firing
     with a `null` counterpart.
  4. `PendingActivationTracker`'s "at capacity with every entry already fully proven, nothing
     evictable" branch (the `else return;` no-op path — its actual defense against ever dropping a
     ready pair under load) had zero test evidence.
  All CONFIRMED as genuine coverage gaps. **Fix:** added one test per gap — a deferred-promise
  non-blocking-response test, two asymmetric-dep tests (each returns 403 for a not-yet-active
  account, same as neither dep present), a null-counterpart test asserting `recordProof` is never
  called, and a capacity-full-of-proven-pairs test asserting the no-op branch neither throws nor
  drops the existing ready pair.
- **Security lens:** no findings — independently re-verified the trust-anchor pattern
  (`index.ts`'s `readApolloCounterpartForAuth` uses `trustAnchorPair()`, same as
  `readApolloPublicKeyForAuth`, not the untrusted hub-fed pool), the env-data injection fix, the
  `isActiveAccount`-gated secret issuance, and the map-key-collision fix — all held.
- **Conventions lens:** no findings — `readApolloCounterpart.ts` matches `dualLinkCache.ts`'s
  dial/error-handling shape; `pendingActivationTracker.ts` matches the `beginFlush`/`commitFlush`
  drain-token pattern (`pythFlushResolver.ts`/`PythLedger`) and the TTL/sweep/clock-injection shape
  (`ephemeralKeyStore.ts`); `dualLinkActivateResolver.ts` mirrors `pythFlushResolver.ts` structurally
  (same `registerServerResolver` usage, same resolve/settle contract); `register.ts`'s round-1
  wiring fix (parameter, not singleton import) confirmed still holding, no regression.

## Verification (after the last edit)

- `npm test -w @ancientpantheon/pythia` → **511 passed (75 files)**.
- `tsc --noEmit` clean. `npm run build --workspace=@ancientpantheon/pythia` clean (only the
  pre-existing, unrelated CSS `@import`-order warning from `@ancientpantheon/codex`'s `ui.css`).

Rounds: 3. Round 1: 2 CRITICAL + 1 MEDIUM fixed. Round 2: 1 HIGH + 2 LOW fixed. Round 3
(terminal, full-scope, 4-lens pass): 1 HIGH (head-of-line blocking) fixed + 4 MEDIUM (test
coverage) fixed; security and conventions lenses returned zero findings. Terminal state: full
suite green, typecheck/build clean, zero unresolved CONFIRMED findings within this topic's scope,
zero STYLISTIC findings raised.
