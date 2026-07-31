# connector-activation-resolver — Design

Topic 2 of the pythia-connector-protocol project (design:
`docs/work/pythia-connector-protocol/design.md`). Depends on Topic 1
(`connector-auth-core`, built + reviewed) — this topic makes Pythia actually
call the on-chain `A_LinkDualApiKey` activation once a consumer has proven
ownership of both Apollo halves, closing the loop Topic 1 left open (Topic 1
only issues ephemeral secrets for accounts that are *already* active; nothing
yet makes a new account active).

## Problem

A consumer's on-chain flow is: deploy both Apollo halves (`C_DeployApolloPythiaApiKey`,
their own tx) → link them into an inactive `DualLink` row (`C_LinkDualApiKey`, their
own tx, both half-owners sign) → get activated (`A_LinkDualApiKey`, Cronoton-gated —
**this is Pythia's job, and nothing calls it today**). The live `PYTHIA.pact` module's
own doc comment confirms the intended trigger: *"Cronoton flips inactive dual row to
active after off-chain Apollo proof (C_Link required first)."* Topic 1 built exactly
that off-chain proof mechanism (the headless challenge/verify round trip) but only
uses it to gate ephemeral-secret issuance for accounts already active — it never
triggers activation itself.

## The pairing problem this topic has to solve

`A_LinkDualApiKey(standard-apollo, smart-apollo)` takes **both halves in one call** —
unlike the flush action, there's no batching. But Topic 1's `/connectors/auth/verify`
proves **one account at a time** (a consumer calls it once per Apollo half it holds).
So activation can only fire once **both** halves of the same `DualLink` pair have
independently completed a successful headless proof — this topic's real job is
tracking that pairing, not just wrapping the on-chain call.

## What's already confirmed reusable (do not rebuild)

- **The drain-resolver pattern**, proven in production: `pythFlushResolver.ts` +
  `khronoton/register.ts`'s `registerServerResolver` wiring — `resolve()` snapshots
  without mutating, `settle()` drains only on confirmed on-chain success, a
  failed/unfired attempt just retries next tick. Same shape here, adapted for a
  single-pair call instead of a batch.
- **`readActiveDualLinkAccounts`'s on-chain-read plumbing shape** (`dualLinkCache.ts`)
  — the same keyless local-read pattern extends cleanly to a new read,
  `UR_Counterpart(apollo-account)` (confirmed present in the live `PYTHIA.pact`:
  `@doc "Other half; BAR until linked (immutable once set)."`), which tells us
  whether an account has already been through `C_Link` and, if so, what its paired
  account is.
- **`trustAnchorPair`** (`connectorVerify.ts`) — this new on-chain read must use it
  too, for the same reason Topic 1's reads do (CRITICAL finding from that review).
- **Topic 1's verify route** (`connectorAuth.ts`) as the trigger point — after a
  successful `apolloVerify`, if the account isn't yet active, this topic hooks in to
  record the proof.
- **Pythia's own Khronoton/Codex signing path**, proven live via the flush action —
  same `pythia-cronoton-keyset` dependency, same "fires cleanly, never crashes, just
  retries" contract once the keyset gets re-pointed (still an external/unresolved
  dependency, tracked separately, not blocking this topic per the same reasoning as
  the flush resolver).

## Decisions

1. **Pairing tracker, not a queue keyed by account.** A new store,
   `PendingActivationTracker`, records a proof per `(dualLinkKey, half)` rather than
   per bare account, so it can tell when BOTH halves of the SAME pair are in. Only
   once both are recorded does the pair become "ready."
2. **One pair per resolver fire, not a batch** — matches `A_LinkDualApiKey`'s actual
   on-chain signature (one call = one pair). If multiple pairs are ready, later ones
   wait for subsequent ticks; this is fine at expected registration volume and keeps
   the resolver a direct structural mirror of the flush one instead of inventing
   batching the chain function doesn't support.
3. **The counterpart read happens at proof-record time, not at resolver-fire time** —
   when `connectorAuth.ts`'s verify route succeeds for an account that
   `dualLinkCache.isActiveAccount()` says is NOT yet active, it reads that account's
   on-chain counterpart once (via the new `readApolloCounterpart`) and hands both the
   proven account AND its counterpart to `PendingActivationTracker.recordProof()`. If
   the counterpart read comes back as the on-chain "unlinked" sentinel (`BAR`), the
   account hasn't been through `C_Link` yet — record nothing (nothing to pair against).
4. **Fire-and-forget on the record side; the resolver alone talks to the Cronoton.**
   `connectorAuth.ts`'s verify route stays a normal request/response HTTP handler — it
   does not itself sign or submit anything, does not block on chain state, and its
   response to the caller is unaffected by whether this recording succeeds. The actual
   on-chain activation is entirely Khronoton's job, on its own schedule.

## New components

1. `apps/pythia/src/connectors/auth/readApolloCounterpart.ts` — `readApolloCounterpart(pair, apolloAccount): Promise<string | null>`, a keyless local read of `(ouronet-ns.PYTHIA.UR_Counterpart "<account>")`, returning `null` when the on-chain value is the unlinked sentinel (mirrors `readActiveDualLinkAccounts`'s request-building shape).
2. `apps/pythia/src/connectors/auth/pendingActivationTracker.ts` — `PendingActivationTracker`: `recordProof(apolloAccount, counterpart)`, `beginActivation(): { pair: {standard, smart}, token } | null` (snapshot ONE ready pair, oldest-first, without mutating), `commitActivation(token)` (drain exactly what was sent, mirroring `PythLedger.beginFlush`/`commitFlush`'s token-based drain).
3. `apps/pythia/src/automaton/khronoton/dualLinkActivateResolver.ts` — `createDualLinkActivateResolver(tracker)`, structurally identical to `pythFlushResolver.ts`'s `resolve()`/`settle()` shape, registered as `"dual-link-activate"`.
4. Wiring: `connectorAuth.ts`'s verify handler gains an optional post-success hook into the tracker (only when the account isn't yet active); `khronoton/register.ts` registers the new resolver alongside the flush one; `index.ts` constructs the tracker and threads it through both.

## Acceptance criteria

- [ ] Proving ownership of only ONE half of a pair (the other never proven, or not yet
      linked on-chain) never triggers activation — `beginActivation()` returns `null`.
- [ ] Proving both halves (in either order, across two separate verify calls) makes
      `beginActivation()` return exactly that one pair.
- [ ] `beginActivation()` never mutates tracker state; only `commitActivation(token)`
      does, and only for the exact pair the token was issued for.
- [ ] The resolver mirrors `pythFlushResolver.ts`'s resolve/settle contract: a failed
      or unconfirmed fire never calls `settle`, so the pair remains pending and is
      offered again on a later tick.
- [ ] `readApolloCounterpart` uses `trustAnchorPair`, not a raw hub-pool read (same
      CRITICAL-class requirement Topic 1's review already established for this class
      of read).
- [ ] Full existing test suite (Topic 1 + everything else) stays green; new code has
      real behavioral tests, not implementation-detail assertions.

## Next step

Plan via `nectar:plan`, then build.
