# pythia-client-connector-sdk — Design

Topic 3 of `docs/work/pythia-connector-protocol/design.md` (the umbrella design — read that first
for the full architecture, wire shapes, and Decisions 1-4). Topics 1 (`connector-auth-core`) and 2
(`connector-activation-resolver`) are both build-complete and reviewed clean on the Pythia service
side; their wire contract is now locked, so this topic builds the consumer-side SDK against it.

## Problem

`packages/pythia-client` (published as `@ancientpantheon/pythia-client`) is today a pure
transport-relay SDK — `read`/`send`/`poll`/`health` — with no concept of the connector protocol at
all. It cannot drive a headless challenge → sign → verify round trip, cannot hold/refresh an
ephemeral secret, and has no way to attach that secret as `x-pythia-key` on a gated request. Per
the umbrella design's own framing, this is deliberately the *last* topic: a consumer automaton
(Pythia herself, later others) needs exactly this package as an `npm` dependency to actually
integrate with Pythia's connector protocol — this is "the whole point," per the umbrella problem
statement. Nothing here is usable end-to-end until this ships.

## What already exists (do not rebuild)

- `PythiaClient` (`client.ts`) — the transport-relay class this topic composes with, not replaces.
- `Transport` (`transport.ts`) — thin `fetchImpl`-injectable HTTP layer already used by every
  existing call; the connector round trip reuses it directly rather than hand-rolling `fetch`
  calls.
- The client-side error taxonomy shape (`errors.ts`/`mapError.ts`) — the connector protocol gets
  its OWN small taxonomy (a distinct wire contract, no `code` discriminator on its error bodies —
  see below), following the same `PythiaClientError`-rooted, `name`-stamped pattern rather than
  reusing the transport-relay classes for an unrelated failure domain.
- The locked wire contract (verified directly against `apps/pythia/src/routes/connectorAuth.ts`,
  not from the design doc's earlier draft):
  - `POST /connectors/auth/challenge` — body `{ apolloAccount }` → `200 { nonce, rp, expiresAt }`
    on a syntactically valid account, else `400 { error: "invalid apollo account" }`.
  - `POST /connectors/auth/verify` — body `{ apolloAccount, nonce, signature }` →
    - `200 { secret, expiresAt }` — success, account is an active dual link.
    - `202 { error: "ownership proven, but not yet an active dual link — no secret issued" }` —
      signature checked out, but the account isn't (yet) active; Topic 2's pairing hook records
      this proof server-side toward eventual on-chain activation. **Not an error** — a legitimate,
      expected steady state for a brand-new consumer whose `A_LinkDualApiKey` hasn't landed yet.
    - `400 { error: "invalid or expired nonce" }` — stale/replayed/unknown nonce.
    - `401 { error: "signature verification failed" }` — bad signature.
    - `403 { error: "not an active dual link" }` — not active AND the server-side pairing hook
      isn't wired (defensive fallback; in the shipped deployment this never actually fires because
      Topic 2's deps are always wired, but the client must still handle it since it's a real,
      documented status the route can return).
    - `502 { error: "verification temporarily unavailable" }` — a transient chain-read failure.
  - Neither response body carries the transport-relay taxonomy's `code` discriminator — these are
    a separate wire contract, confirmed by reading the route handler directly.

## What's net-new (this topic)

1. **`ApolloSigner` interface** — the injection point for a consumer's OWN signing capability
   (e.g. Codex's `autoSignApolloChallenge`, out of scope/repo for this SDK). This package never
   holds key material and signs nothing itself — mirrors `PythiaClient.send`'s existing "caller
   signs, we relay" philosophy, applied to the challenge/verify round trip instead.
2. **`SecretStorage` interface** — the injection point for a consumer's OWN persistence (e.g.
   "seal secret in own vault," per the umbrella design's architecture step 4). Ships with one
   trivial built-in implementation, `InMemorySecretStorage`, so the SDK is usable standalone
   without forcing every consumer to write a storage adapter before their first test.
3. **`PythiaConnector`** — orchestrates the full round trip (challenge → sign → verify → store)
   against the two injected interfaces plus `Transport`. Exposes a single pull-based primitive,
   `ensureSecret()`, that returns a cached still-valid secret or transparently refreshes — no
   built-in timer/loop (see Decision 1 below).
4. **`PythiaClientOptions.pythiaKey`** — a small addition to the EXISTING `PythiaClient`/
   `Transport` so a connector's live secret can actually be attached as `x-pythia-key` on
   `read`/`send`/`poll` calls (today `Transport` sends no custom headers at all — this is a real
   gap, not an oversight, since gating didn't exist before Topic 1).
5. Package version bump + CHANGELOG + README updates (the publish workflow's own documentation
   gates require both, checked below).

## Decisions

1. **No built-in timer/loop in `PythiaConnector`.** The umbrella design's architecture diagram
   describes "a scheduled loop (every 3h)," but that loop is Khronoton/cronoton machinery living
   in the CONSUMER's own automaton runtime (a browser tab, a long-running Node service, a
   short-lived CLI invocation — very different lifecycle shapes). `pythia-client` stays
   dependency-light and runtime-agnostic per its own established README framing ("no runtime
   dependencies... rests only on the runtime `fetch`"); it exposes `ensureSecret()` as a pull-based
   primitive a consumer calls from whatever scheduling mechanism it already has (its own Khronoton
   tick, a `setInterval`, a request-time check) rather than owning a `setInterval`/`.unref()` loop
   itself. This mirrors `PythiaClient` itself, which is already call-when-you-need-it with no
   background loop of its own.
2. **`ensureSecret()` is pull-based and self-healing across the pending state**, not a one-shot.
   A consumer whose dual link isn't active yet gets `{ status: "pending" }` back (not a thrown
   error — see below) and is expected to call `ensureSecret()` again later (its own retry
   cadence); each call transparently re-attempts the full round trip when there's no cached valid
   secret, so a pair that WAS pending and has since been activated on-chain (Topic 2 fired
   `A_LinkDualApiKey`) starts succeeding on a later call with zero code change needed on the
   consumer's side.
3. **The 202 "pending" outcome is a typed result, not a thrown error.** `refresh()`/`ensureSecret()`
   return a discriminated union (`{status: "active", secret, expiresAt} | {status: "pending"}`)
   rather than throwing for 202 — it's an expected, non-exceptional steady state (a brand-new
   consumer waiting on activation), unlike 400/401/403/502 which genuinely are caller/environment
   errors and DO throw typed errors. Forcing every consumer to `try/catch` the normal "not active
   yet" case would be worse ergonomics than a plain status check.
4. **`pythiaKey` is a static-string-OR-supplier-function option on `PythiaClientOptions`,** not a
   separate always-required constructor param. A static string covers the simple case (a
   long-lived permanent `pk_live_...` key, or a manually-managed secret); a supplier function
   (`() => string | undefined | Promise<...>`) is what `PythiaConnector.keyProvider()` returns, so
   a `PythiaClient` can be wired directly to a live, auto-refreshing connector without the caller
   ever re-constructing the client on secret rotation. `undefined`/omitted → today's unchanged
   anonymous behavior (Topic 1's own pinned gating rule: no header at all falls through to the
   existing "direct" bucket).

## Architecture

```
Consumer app
  signer: ApolloSigner            (consumer's own — e.g. wraps Codex autoSignApolloChallenge)
  storage: SecretStorage          (consumer's own — e.g. wraps its vault; optional, defaults in-memory)
        │
        ▼
  new PythiaConnector({ baseUrl, apolloAccount, signer, storage })
        │  .ensureSecret() ─── pull-based; internally: cached-and-valid? return it
        │                                              : else challenge → sign → verify → store
        ▼
  { status: "active", secret, expiresAt } | { status: "pending" }
        │
        ▼  connector.keyProvider() → () => Promise<string | undefined>
  new PythiaClient({ baseUrl, pythiaKey: connector.keyProvider() })
        │  every read/send/poll now carries `x-pythia-key: <live secret>` when active
        ▼
  Pythia gateway (Topic 1's gate middleware)
```

## Acceptance criteria

- [ ] `PythiaConnector.ensureSecret()` drives a full challenge → sign → verify round trip against
      injected `ApolloSigner`/`SecretStorage` (or the default in-memory storage), returns
      `{status:"active", secret, expiresAt}` on a 200 verify, and stores it.
- [ ] A cached, still-valid (not within `refreshMarginMs` of `expiresAt`) secret is returned
      WITHOUT a new round trip — no redundant challenge/verify calls.
- [ ] A 202 verify response yields `{status:"pending"}`, never a thrown error, and clears any
      stale cached secret rather than leaving one to be returned by a later call.
- [ ] Each of 400 (challenge validation, and verify nonce error), 401, 403, and 502 maps to its
      own typed `PythiaConnectorError` subclass and is thrown, not silently swallowed.
- [ ] `PythiaClientOptions.pythiaKey` (string or supplier) results in `x-pythia-key` being sent on
      `read`/`send`/`poll` requests when resolved to a defined value, and NO such header at all
      when unset/resolves to `undefined` (never sends an empty-string header).
- [ ] `PythiaConnector.keyProvider()` composes with `PythiaClient` end-to-end: a full round trip
      exercised via `PythiaClient`'s own request path (not just unit-testing `PythiaConnector` in
      isolation) proves the live secret actually reaches the `x-pythia-key` header.
- [ ] Full existing `packages/pythia-client` test suite stays green; new code has real behavioral
      tests, not implementation-detail assertions.
- [ ] Version bump (root `package.json` + all 4 unified-version mirrors per
      `apps/pythia/src/versionConsistency.test.ts`), CHANGELOG entry, and README `## Status` +
      version-history updates satisfying `publish.yml`'s own documentation gates (verified by
      dry-running the same three greps the workflow uses, before considering this topic done).

## Next step

Plan via a task breakdown mirroring Topics 1/2's wave structure (build the two new interfaces +
`PythiaConnector` first, then the `pythiaKey` wiring into the existing `Transport`/`PythiaClient`
since the integration test in Wave 2 depends on both existing).
