# connector-auth-core — Plan

Topic 1 of the pythia-connector-protocol project (design:
`docs/work/pythia-connector-protocol/design.md`). Builds the full server-side headless
challenge/verify/ephemeral-secret round trip and real request gating — everything needed for a
consumer to autonomously prove Apollo ownership and get a working, TTL'd, gated API credential.
Does NOT include making a new on-chain `DualLink` active (Topic 2) or the consumer-side SDK
(Topic 3); this topic is tested end-to-end against an injected/mocked active-dual-link set.
Test command: `npm test -w @ancientpantheon/pythia`.

## Wave 1

- [x] T1: `apps/pythia/src/connectors/auth/dualLinkCache.ts` — a cached mirror of the on-chain
      active-`DualLink` set — done when: `readActiveDualLinkAccounts(pair: {primary: DialNode,
      fallback: DialNode})` does a keyless Pact local read of
      `(ouronet-ns.PYTHIA.UR_ActiveDualLinkSet)` (mirror the request-building/error-handling shape
      of `readApolloPublicKey.ts`), splits each returned 325-char composite `dual-link-key` into
      its 162-char standard half + 162-char smart half (`standard = key.slice(0, 162)`,
      `smart = key.slice(162 + BAR.length)`, where `BAR` is read from the same constant/convention
      `UC_DualLinkKey` uses on-chain — hardcode the literal BAR separator value used by
      `apps/pythia/src/connectors/verify/canonicalMessage.ts`'s sibling on-chain reads, or import
      it if already exported from an existing util; if neither, define
      `const PYTHIA_DUAL_LINK_BAR = ...` locally with a comment citing the on-chain `CT_Bar`
      source), and returns a `Set<string>` containing both halves of every active link. A
      `DualLinkCache` class polls this on an interval (mirror `NodePool`'s self-rescheduling
      `setTimeout` + `.unref()` loop, default 60s, `start()`/`stop()`), starts with an empty set
      (fails closed — nothing verifies as active until the first successful poll), keeps the
      last-good set on a poll failure (never clears on error, mirroring `NodePool.refreshNow`'s
      keep-last-good-on-failure behavior), and exposes `isActiveAccount(apolloAccount: string):
      boolean`. Constructor takes an injectable `poll: () => Promise<Set<string>>` so tests never
      touch the network. Tests: splits a known composite key into the correct two halves; starts
      empty and `isActiveAccount` returns false pre-poll; after a successful poll,
      `isActiveAccount` is true for both halves of a returned link and false for an unrelated
      account; a poll rejection leaves the previous successful set intact (not cleared).
  - files: `apps/pythia/src/connectors/auth/dualLinkCache.ts`, `apps/pythia/src/connectors/auth/dualLinkCache.test.ts`

- [x] T2: `apps/pythia/src/connectors/auth/nonceStore.ts` — a headless (no cookie/session), TTL'd,
      single-use nonce store — done when: `AuthNonceStore.issue(apolloAccount: string): { nonce:
      string; expiresAt: number }` mints a `randomBytes(24).toString("hex")` nonce bound to the
      given account with `expiresAt = Date.now() + CHALLENGE_TTL_SECONDS * 1000` (reuse the
      existing `CHALLENGE_TTL_SECONDS` constant from `apps/pythia/src/connectors/verify/canonicalMessage.ts`,
      imported not redefined); `consume(nonce: string, apolloAccount: string): boolean` returns
      `true` exactly once for a matching, unexpired, un-consumed `(nonce, apolloAccount)` pair and
      `false` on any replay, account mismatch, unknown nonce, or expiry (deleting the entry on a
      successful consume so it can never be replayed). Bound total stored entries at 10000
      (mirror `MAX_CHALLENGES` from `apps/pythia/src/connectors/verify/store.ts`, dropping the
      oldest on overflow) and lazily sweep expired entries on `issue()` (mirror that file's
      `sweep()` pattern). Tests: issue then consume with the right account succeeds once and fails
      on a second attempt (replay); consume with the wrong account for a real nonce fails; consume
      of an unknown nonce fails; consume after `expiresAt` has passed fails (inject a fake clock).
  - files: `apps/pythia/src/connectors/auth/nonceStore.ts`, `apps/pythia/src/connectors/auth/nonceStore.test.ts`

- [x] T3: `apps/pythia/src/connectors/auth/ephemeralKeyStore.ts` — the TTL'd, gated-request bearer
      secret store — done when: `EPHEMERAL_SECRET_TTL_MS = 3 * 60 * 60 * 1000` is exported;
      `EphemeralKeyStore.issue(apolloAccount: string): { secret: string; expiresAt: number }`
      mints `` `pk_eph_${randomBytes(24).toString("base64url")}` ``, stores only its SHA-256 hash
      keyed by hash (mirror `ConnectorStore`'s `hashKey`/`keyHash` convention in
      `apps/pythia/src/connectors/store.ts` — do not store the raw secret), records the owning
      `apolloAccount` and `expiresAt = now + EPHEMERAL_SECRET_TTL_MS`; `resolve(secret: string):
      { apolloAccount: string } | null` hashes the input, looks it up, returns `null` (and deletes
      the entry) if absent or `expiresAt` has passed, else returns the owning account;
      `sweepExpired(): number` purges all expired entries and returns the count removed; `start()`/
      `stop()` run `sweepExpired()` on a `setInterval` (mirror `UsageReporter`'s
      `start()`/`stop()`/`.unref()` shape in `apps/pythia/src/stats/usageReporter.ts`, default
      interval 5 minutes). Constructor takes an injectable clock (`clock?: () => number`, default
      `Date.now`) for deterministic expiry tests. Tests: issue then resolve returns the correct
      account; resolve of an unknown secret returns null; resolve after TTL elapses (via injected
      clock) returns null and the entry is gone from a subsequent `sweepExpired()` count; two
      `issue()` calls for different accounts never collide; the raw secret string never appears in
      the store's persisted/inspectable state (only its hash).
  - files: `apps/pythia/src/connectors/auth/ephemeralKeyStore.ts`, `apps/pythia/src/connectors/auth/ephemeralKeyStore.test.ts`

## Wave 2 (depends on Wave 1)

- [x] T4: `apps/pythia/src/routes/connectorAuth.ts` — the headless challenge/verify HTTP routes —
      done when: `registerConnectorAuth(app: Hono, deps: { nonceStore: AuthNonceStore,
      ephemeralKeyStore: EphemeralKeyStore, dualLinkCache: DualLinkCache, readApolloPublicKey:
      (apolloAccount: string) => Promise<string> })` registers two routes. `POST
      /connectors/auth/challenge` — body `{ apolloAccount: string }`; validates the account is a
      `₱.`/`Π.`-prefixed 162-char string (mirror the validation already in
      `apps/pythia/src/routes/connectorVerify.ts`'s `isStandardApollo`/`isSmartApollo` checks),
      `400` on a malformed account; else calls `nonceStore.issue(apolloAccount)` and responds `200
      { nonce, rp: RP, expiresAt }` (import `RP` from `canonicalMessage.ts`, do not redefine).
      `POST /connectors/auth/verify` — body `{ apolloAccount: string; nonce: string; signature:
      string }`; `400 { error: "invalid or expired nonce" }` when `nonceStore.consume(nonce,
      apolloAccount)` is false; `403 { error: "not an active dual link" }` when
      `dualLinkCache.isActiveAccount(apolloAccount)` is false; else reads the on-chain public key
      via the injected `readApolloPublicKey`, builds the canonical message via
      `buildChallengeMessage({ apollo: apolloAccount, nonce, rp: RP })` (imported, not
      reimplemented), calls the existing `apolloVerify(signature, message, publicKey)` from
      `apps/pythia/src/connectors/verify/apolloVerify.ts`, responds `401 { error: "signature
      verification failed" }` on a false result, else calls `ephemeralKeyStore.issue(apolloAccount)`
      and responds `200 { secret, expiresAt }`. Tests (using `app.request(...)` against a Hono
      instance wired with real `AuthNonceStore`/`EphemeralKeyStore` instances and injected fakes
      for `dualLinkCache`/`readApolloPublicKey`/a stub `apolloVerify` result path): full success
      round trip returns a secret; malformed account on challenge → 400; expired/wrong-account
      nonce on verify → 400; inactive dual-link account → 403; wrong signature → 401; a second
      verify attempt reusing the same nonce → 400 (replay rejected).
  - files: `apps/pythia/src/routes/connectorAuth.ts`, `apps/pythia/src/routes/connectorAuth.test.ts`

- [x] T5: `apps/pythia/src/connectors/auth/gateMiddleware.ts` — real request gating on
      `x-pythia-key` for operational routes — done when: `apps/pythia/src/stats/middleware.ts`'s
      `OPERATIONAL_PATH` constant is changed from `const OPERATIONAL_PATH` to `export const
      OPERATIONAL_PATH` (its value and every existing behavior in that file stay byte-identical —
      this is the one-line export addition, nothing else in the file changes), and
      `connectorGateMiddleware(store: EphemeralKeyStore)` in the new file imports and reuses that
      same exported regex rather than duplicating the pattern. Middleware behavior: on a
      non-matching path,
      calls `next()` unchanged; on a matching path with NO `x-pythia-key` header, calls `next()`
      unchanged (today's open/"direct" behavior, no regression); on a matching path WITH a header
      that `store.resolve(key)` returns `null` for, responds `401 { error: "invalid or expired
      connector key" }` and does NOT call `next()`; on a matching path with a header that resolves
      successfully, calls `next()`. Tests: a `/healthz` request (non-matching path) with a bogus
      key still succeeds (middleware doesn't touch it); a `/stoachain/read` request with no key
      header passes through to a stub downstream handler; the same route with an unknown/expired
      key is rejected with 401 and the downstream handler is never invoked; the same route with a
      key freshly issued by a real `EphemeralKeyStore` passes through.
  - files: `apps/pythia/src/connectors/auth/gateMiddleware.ts`, `apps/pythia/src/connectors/auth/gateMiddleware.test.ts`, `apps/pythia/src/stats/middleware.ts`

## Wave 3 (depends on Wave 2)

- [x] T6: Wire the connector-auth system into the composition root — done when:
      `apps/pythia/src/index.ts` constructs one `DualLinkCache`, one `AuthNonceStore`, and one
      `EphemeralKeyStore` (each exported the same way `sealedVault`/`settingsStore` etc. already
      are), calls `registerConnectorAuth(app, { nonceStore, ephemeralKeyStore, dualLinkCache,
      readApolloPublicKey })` alongside the existing route registrations (after
      `registerConnectorVerify`, before the static catch-all — matching where every other
      operational route is registered), applies `app.use("*", connectorGateMiddleware(ephemeralKeyStore))`
      positioned AFTER the existing `statsMiddleware`/`pythMeterMiddleware` `app.use` calls (so a
      gated-and-rejected request is still counted/metered, matching how every other layered
      middleware in this file is ordered), and calls `dualLinkCache.start()` +
      `ephemeralKeyStore.start()` alongside the existing `nodePool.start()` /
      `txTracker.start()` / `usageReporter.start()` block. Done when: `npm test -w
      @ancientpantheon/pythia` reports the full suite green including all Wave 1 + Wave 2 test
      files, `npm run typecheck --workspace=@ancientpantheon/pythia` is clean, `npm run build
      --workspace=@ancientpantheon/pythia` is clean, and a manual `curl localhost:<port>/healthz`
      against the built dev server still returns `200` with the existing response shape unchanged
      (gating must not touch non-operational routes).
  - files: `apps/pythia/src/index.ts`
