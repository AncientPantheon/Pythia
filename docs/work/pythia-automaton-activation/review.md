# pythia-automaton-activation — Review

Adversarial review of the four-topic project (verify→autonomous activation, liveness green-check,
Tier-3 routing, verifier doc) before the v2.7.17 release. Focus: runtime correctness of the code
changes, keyless-invariant isolation, and router edge cases.

## Findings

### MED (FIXED) — `/api/connectors/verify/status` could falsely report `"activated"` for a cross-pair

The status endpoint originally derived `"activated"` from `bothProven` (two independent per-account
proofs in the session) combined with the tracker no longer holding the pair. In a session that
verified two *different* pairs `(₱.A, Π.B)` and `(₱.C, Π.D)`, querying a mismatched cross-pair
`?standard=₱.A&smart=Π.D` — never recorded, never activated — returned tracker `"none"` + `bothProven
true` → a false `"activated"`. Reachable by an operator selecting a std half and a smart half proven
under different pairs.

**Fix:** made `"activated"` authoritative rather than inferred. `PendingActivationTracker` now retains
a short-lived record (`ACTIVATED_RETENTION_MS`, TTL+cap-bounded) of pairs that were **committed** — a
real `commitActivation`, which only fires on a CONFIRMED on-chain success — and `statusOf` returns a
new `"activated"` state from it. The endpoint derives the phase from `statusOf` alone (no `bothProven`
inference), so a never-recorded cross-pair reports `"pending"`, never `"activated"`. This also
resolves the LOW (map-full `recordProof` no-op yielding a false `"activated"`) and the fragile-TTL
note (the old invariant depended on `PROVEN_TTL_MS` < the tracker TTL). Tests added:
`pendingActivationTracker.test.ts` (`none → half → ready → activated`; never-recorded = `none`;
retention expiry) and `connectorVerify.test.ts` (a both-proven-but-never-recorded pair → `pending`).

## Areas checked and found clean

- `statusOf` — order-independent (sorted `pairKey`), self-referential `a===b` → `none`, expiry-checked.
- The callback both-proven bridge — fires `recordProof` exactly when both of the challenge's own
  (distinct, one-Standard-one-Smart) halves are in the cumulative proven set; no wrong-pair / missed fire.
- Admin Tier-3 router — `splitViewSubtab` handles bare view (→ default), unknown subtab (→ default, not
  404), deeper paths (→ not-found), legacy redirects (once, then re-route); no hashchange loop.
- Activation poll loop (`app.js`) — single-timer-guarded, bounded (~21 ticks), self-clearing on any
  non-`activating` phase and on exhaustion; no leak, no double-timer.
- Keyless invariant — `healthz.ts` imports no automaton core; capability flags are computed in the
  composition root (`index.ts`), the only module permitted to reach `register.js`. `pnpm`/`vitest`
  keyless-invariant scanner green.

## Outcome

One MED fixed with an authoritative, commit-based `"activated"` signal + 3 tests encoding the exact
failure scenario. Full suite green (pythia 591, pythia-client 96), typecheck clean, keyless invariant
holds. Released as v2.7.17.
