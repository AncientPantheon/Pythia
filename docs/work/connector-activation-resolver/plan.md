# connector-activation-resolver — Plan

Topic 2 of the pythia-connector-protocol project (design:
`docs/work/connector-activation-resolver/design.md`). Test command:
`npm test -w @ancientpantheon/pythia`.

## Wave 1

- [ ] T1: `apps/pythia/src/connectors/auth/readApolloCounterpart.ts` — on-chain read of an
      Apollo account's linked counterpart — done when: `readApolloCounterpart(pair:
      {primary: DialNode, fallback: DialNode}, apolloAccount: string, opts?: {chainId?:
      number, fetchImpl?: FetchImpl}): Promise<string | null>` does a keyless Pact local
      read of `(ouronet-ns.PYTHIA.UR_Counterpart "<apolloAccount>")` (mirror
      `apps/pythia/src/connectors/auth/dualLinkCache.ts`'s `readActiveDualLinkAccounts`
      for the request-building/dial/error-handling shape — read that file first as the
      template, including its `dial()`/`buildLocalCommand` usage), REJECTS on a
      non-"success" status or malformed response (same fail-closed contract as
      `readActiveDualLinkAccounts` — do not silently return `null` on a read failure,
      only on a well-formed response), and returns `null` specifically when the returned
      `data` string equals the on-chain "unlinked" sentinel value (the same separator
      literal already defined as `PYTHIA_DUAL_LINK_BAR` in `dualLinkCache.ts` — import
      it, do not redefine), else returns the counterpart account string. Tests: a
      well-formed response with a real counterpart string returns it; a well-formed
      response whose data equals the BAR sentinel returns `null`; a non-"success" status
      response rejects (throws), it does not resolve to `null`.
  - files: `apps/pythia/src/connectors/auth/readApolloCounterpart.ts`, `apps/pythia/src/connectors/auth/readApolloCounterpart.test.ts`

- [ ] T2: `apps/pythia/src/connectors/auth/pendingActivationTracker.ts` — pairs two
      independent per-half proofs into one ready-to-activate pair — done when:
      `PendingActivationTracker.recordProof(apolloAccount: string, counterpart:
      string): void` records that `apolloAccount` has proven ownership and is paired
      with `counterpart` (order-independent — the SAME pair recorded from either half
      first must converge on one pending entry, keyed by e.g. the sorted
      `[account, counterpart]` pair joined, not by insertion order); calling it a second
      time for the OTHER half of the same pair marks that pair ready (both halves
      proven); `beginActivation(): { pair: { standard: string; smart: string }; token:
      string } | null` returns the OLDEST ready pair (classified into standard/smart via
      the account's `₱`/`Π` prefix codepoint — import `isStandardApollo`/`isSmartApollo`
      from `apps/pythia/src/routes/connectorVerify.js` rather than reimplementing) WITHOUT
      removing it from pending state, or `null` if no pair is ready; `commitActivation
      (token: string): void` removes exactly the pair that `token` was issued for (a
      stale/unknown token is a no-op, not a throw). Tests: recording only one half of a
      pair never makes `beginActivation()` return it; recording both halves (in each of
      the two possible orders — standard-then-smart, and smart-then-standard) makes
      `beginActivation()` return exactly that pair; `beginActivation()` called twice in a
      row without an intervening `commitActivation()` returns the SAME pair both times
      (not removed by reading); `commitActivation(token)` removes the pair so a
      subsequent `beginActivation()` returns `null` (or the next ready pair, if a second
      one exists); two independent pairs recorded are each returned/committed
      independently without interference.
  - files: `apps/pythia/src/connectors/auth/pendingActivationTracker.ts`, `apps/pythia/src/connectors/auth/pendingActivationTracker.test.ts`

## Wave 2 (depends on Wave 1)

- [ ] T3: `apps/pythia/src/automaton/khronoton/dualLinkActivateResolver.ts` — the
      `dual-link-activate` single-tx server resolver — done when: it exports
      `DUAL_LINK_ACTIVATE_RESOLVER = "dual-link-activate"` and
      `createDualLinkActivateResolver(tracker: PendingActivationTracker):
      SingleTxResolver` and `registerDualLinkActivateResolver(tracker:
      PendingActivationTracker): void`, structured identically to
      `apps/pythia/src/automaton/khronoton/pythFlushResolver.ts` (read that file first as
      the exact template — same `registerServerResolver` import, same doc-comment
      density): `resolve()` calls `tracker.beginActivation()`; if it returns `null`,
      `resolve()` returns `{ plan: [], payload: { standardApollo: "", smartApollo: "" }
      }` (a genuinely empty/no-op fire — mirror how the flush resolver would look with
      zero entries, check `pythFlushResolver.ts`/`PythLedger.beginFlush` for the
      established "nothing to do" shape and match it) — if it returns a pair, `resolve()`
      returns `{ plan: [token], payload: { standardApollo: pair.standard, smartApollo:
      pair.smart } }`; `settle(plan)` calls `tracker.commitActivation(token)` only when
      `plan[0]` is present (mirrors `pythFlushResolver.ts`'s `settle` exactly). Tests:
      `resolve()` with nothing pending returns the empty/no-op payload shape and an empty
      plan; `resolve()` with a ready pair returns that pair's accounts in the payload and
      a non-empty plan; `settle()` with a real plan calls `commitActivation` with the
      right token (verify via a fake/spy `PendingActivationTracker`); `settle()` with an
      empty plan is a no-op (does not call `commitActivation`).
  - files: `apps/pythia/src/automaton/khronoton/dualLinkActivateResolver.ts`, `apps/pythia/src/automaton/khronoton/dualLinkActivateResolver.test.ts`

- [ ] T4: Hook `apps/pythia/src/routes/connectorAuth.ts`'s verify handler into the
      activation tracker — done when: `ConnectorAuthDeps` gains two new OPTIONAL fields,
      `readApolloCounterpart?: (apolloAccount: string) => Promise<string | null>` and
      `pendingActivation?: { recordProof(apolloAccount: string, counterpart: string):
      void }` (an interface, not the concrete class, so the route file doesn't import
      the tracker's implementation — keep this route's file scope from growing into
      Topic 2's automaton-side files); after a successful `apolloVerify` AND
      `ephemeralKeyStore.issue(...)`, if BOTH `deps.readApolloCounterpart` and
      `deps.pendingActivation` are present, AND `deps.dualLinkCache.isActiveAccount
      (apolloAccount)` was false (i.e. this account is not yet active — read this from
      the SAME check already performed earlier in the handler, don't re-derive it),
      call `readApolloCounterpart(apolloAccount)`; if it resolves to a non-null string,
      call `pendingActivation.recordProof(apolloAccount, counterpart)`. This entire block
      must be fire-and-forget with respect to the HTTP response — the route's existing
      response (`200 { secret, expiresAt }`) is returned exactly as before regardless of
      whether this block runs, succeeds, or fails; wrap it in its own try/catch that
      only logs on failure and never affects the response or the response timing (do not
      `await` it before returning — call it and let it run, catching internally). Both
      deps stay optional and Topic 1's existing tests (which never pass them) must keep
      passing UNCHANGED. Tests: a verify success for an account that IS already active
      never calls `readApolloCounterpart`/`recordProof` even when both deps are supplied
      (nothing to activate); a verify success for a NOT-yet-active account, with a
      counterpart deps that resolves to a real string, results in `recordProof` being
      called with the right two arguments (verify via a spy); a verify success where
      `readApolloCounterpart` rejects does not affect the route's own 200 response or
      throw out of the handler.
  - files: `apps/pythia/src/routes/connectorAuth.ts`, `apps/pythia/src/routes/connectorAuth.test.ts`

## Wave 3 (depends on Wave 2)

- [ ] T5: Wire the activation resolver + tracker into the composition root — done when:
      `apps/pythia/src/index.ts` constructs one `PendingActivationTracker` (exported the
      same way `dualLinkCache`/`authNonceStore` already are), passes it plus a
      `readApolloCounterpart` closure (same `trustAnchorPair({ pool: nodePool, txSenders:
      txSenderStore })`-per-call pattern already used for `readApolloPublicKeyForAuth`)
      into `registerConnectorAuth`'s `deps`, and
      `apps/pythia/src/automaton/khronoton/register.ts` calls
      `registerDualLinkActivateResolver(tracker)` alongside the existing
      `registerPythFlushResolver(ledger)` call (same idempotent-registration comment
      style). Done when: `npm test -w @ancientpantheon/pythia` full suite green
      (Topic 1's 476 plus all of Topic 2's new tests), `npm run typecheck
      --workspace=@ancientpantheon/pythia` clean, `npm run build
      --workspace=@ancientpantheon/pythia` clean.
  - files: `apps/pythia/src/index.ts`, `apps/pythia/src/automaton/khronoton/register.ts`
