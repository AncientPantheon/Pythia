# Changelog

All notable changes to `@ancientpantheon/pythia-client` are documented here.

## 2.7.19 — 2026-08-03

Version alignment: the client jumps from `2.7.18` to `2.7.19` to align with the unified Pythia service
version line. Service-side only (picking an event-driven server resolver now forces its cronoton
scheduleless — scheduling turns off; see `CHANGELOG.md` at the repo root) — no changes to this package's
own source, API surface, or behavior.

## 2.7.18 — 2026-08-03

Version alignment: the client jumps from `2.7.17` to `2.7.18` to align with the unified Pythia service
version line. Service-side only (dual-link activation is now truly event-driven/scheduleless — the link
event fires `A_LinkDualApiKey` immediately, no schedule tick; see `CHANGELOG.md` at the repo root) — no
changes to this package's own source, API surface, or behavior.

## 2.7.17 — 2026-08-03

Version alignment: the client jumps from `2.7.16` to `2.7.17` to align with the unified Pythia
service version line. This release is service-side only (the connector verify flow now bridges into
autonomous `A_LinkDualApiKey` activation, an automaton liveness green-check on `/healthz`, and Tier-3
admin URL routing — see `CHANGELOG.md` at the repo root) — no changes to this package's own source,
API surface, or behavior.

## 2.7.16 — 2026-08-03

Version alignment: the client jumps from `2.7.15` to `2.7.16` to align with the unified Pythia
service version line. This release is service-side only (the Pyth Flush cronoton now encodes its
entry numbers as explicit Pact values so A_Flush type-checks — see `CHANGELOG.md` at the repo root) —
no changes to this package's own source, API surface, or behavior.

## 2.7.15 — 2026-08-03

Version alignment: the client jumps from `2.7.13` to `2.7.15` to align with the unified Pythia
service version line. This release is service-side only (Khronoton signing now delegates key
derivation to Codex's own resolver instead of hand-rolling it — see `CHANGELOG.md` at the repo root)
— no changes to this package's own source, API surface, or behavior.

## 2.7.13 — 2026-08-03

Version alignment: the client jumps from `2.7.12` to `2.7.13` to align with the unified Pythia
service version line. This release is service-side only (Khronoton can now sign with a
chainweaver/eckowallet operator seed — see `CHANGELOG.md` at the repo root) — no changes to this
package's own source, API surface, or behavior.

## 2.7.12 — 2026-08-02

Version alignment: the client jumps from `2.7.11` to `2.7.12` to align with the unified Pythia
service version line. This release is service-side only (the Khronoton simulate's real error now
surfaces in the UI instead of a generic "network error" — see `CHANGELOG.md` at the repo root) — no
changes to this package's own source, API surface, or behavior.

## 2.7.11 — 2026-08-02

Version alignment: the client jumps from `2.7.10` to `2.7.11` to align with the unified Pythia
service version line. This release is service-side only (a hotfix for a khronoton-core 0.6.0 crash
that white-screened the Khronoton admin page — see `CHANGELOG.md` at the repo root) — no changes to
this package's own source, API surface, or behavior.

## 2.7.10 — 2026-08-02

Version alignment: the client jumps from `2.7.9` to `2.7.10` to align with the unified Pythia
service version line. This release is service-side only (the Khronoton Builder admin UI gained a
Back button — see `CHANGELOG.md` at the repo root) — no changes to this package's own source, API
surface, or behavior.

## 2.7.9 — 2026-08-02

Version alignment: the client jumps from `2.7.8` to `2.7.9` to align with the unified Pythia
service version line. This release is service-side only (the Khronoton admin now surfaces a
throwing handler's real error instead of a generic "network error" — see `CHANGELOG.md` at the repo
root) — no changes to this package's own source, API surface, or behavior.

## 2.7.8 — 2026-08-02

Version alignment: the client jumps from `2.7.7` to `2.7.8` to align with the unified Pythia
service version line. This release is service-side only (the Khronoton Kadena signing-key picker now
excludes Apollo-format keys by key SHAPE, fixing a case v2.7.7's metadata filter missed — see
`CHANGELOG.md` at the repo root) — no changes to this package's own source, API surface, or behavior.

## 2.7.7 — 2026-08-02

Version alignment: the client jumps from `2.7.6` to `2.7.7` to align with the unified Pythia
service version line. This release is service-side only (Khronoton admin: the Server Resolver
dropdown now offers the already-registered resolvers, and the Kadena signing-key picker excludes
Apollo-curve keys — see `CHANGELOG.md` at the repo root) — no changes to this package's own source,
API surface, or behavior.

## 2.7.6 — 2026-08-02

Version alignment: the client jumps from `2.7.5` to `2.7.6` to align with the unified Pythia
service version line. This release is service-side only (Self Connector panel: seconds-ticking
countdown + a normal, non-square Link button — see `CHANGELOG.md` at the repo root) — no changes
to this package's own source, API surface, or behavior.

## 2.7.5 — 2026-08-02

Version alignment: the client jumps from `2.7.4` to `2.7.5` to align with the unified Pythia
service version line. This release is service-side only (Self Connector panel layout fix + an
already-linked pair no longer shows a false "Not linked" after a redeploy — see `CHANGELOG.md` at
the repo root) — no changes to this package's own source, API surface, or behavior.

## 2.7.4 — 2026-08-02

Version alignment: the client jumps from `2.7.3` to `2.7.4` to align with the unified Pythia
service version line. This release is service-side only (fixes a race where an in-flight
blue-green deploy could silently undo an admin's Pyth ledger "Nuke" — see `CHANGELOG.md` at the
repo root) — no changes to this package's own source, API surface, or behavior.

## 2.7.3 — 2026-08-01

Version alignment: the client jumps from `2.7.2` to `2.7.3` to align with the unified Pythia
service version line. This release is service-side only (the admin Self Connector panel now shows
a single consolidated ephemeral secret, matching `DualLinkConnector.status()`'s own already-existing
dedup, instead of two misleading per-half ones — see `CHANGELOG.md` at the repo root) — no changes
to this package's own source, API surface, or behavior.

## 2.7.2 — 2026-08-01

Version alignment: the client jumps from `2.7.1` to `2.7.2` to align with the unified Pythia
service version line. This release is service-side only (Self Connector's Link action now drives
an immediate chain check instead of waiting up to 24h for the next scheduled tick — see
`CHANGELOG.md` at the repo root) — no changes to this package's own source, API surface, or
behavior.

## 2.7.1 — 2026-08-01

Version alignment: the client jumps from `2.7.0` to `2.7.1` to align with the unified Pythia
service version line. This release is a CI-flakiness fix on the service side only (a test-timing
budget fix, no production code changed — see `CHANGELOG.md` at the repo root) — no changes to this
package's own source, API surface, or behavior.

## 2.7.0 — 2026-08-01

Version alignment: the client jumps from `2.6.0` to `2.7.0` to align with the unified Pythia
service version line. This release is service-side only (Pythia's self-connector signing now
routes through her own Codex instead of generating locally — see `CHANGELOG.md` at the repo root)
— no changes to this package's own source, API surface, or behavior.

## 2.6.0 — 2026-08-01

- **Added: `maskSecret(secret)`** — a tiny, pure, dependency-free helper that masks an ephemeral
  secret for display, returning `` `${secret.slice(0, 7)}...${secret.slice(-7)}` `` for any string
  of at least 14 characters (every real ephemeral secret is well over this) and the string
  unchanged, un-masked, for anything shorter — never produces overlapping or negative-slice
  garbage on a short input. Extracted from the masked-secret display Pythia's own Self Connector
  admin panel now uses, published so any consumer building a UI around an active connector's
  secret doesn't have to reimplement this from scratch.
- **Fixed: `APOLLO_ACCOUNT_LEN` and `DUAL_LINK_BAR` are now re-exported from the package's public
  `index.ts`.** Both existed in source (`dualLinkKey.ts`, shipped in v2.5.0) but were never actually
  wired into the top-level export list — a v2.5.0 oversight. A consumer building a composite
  `dual-link-key` string (e.g. `` `${standardApollo}${DUAL_LINK_BAR}${smartApollo}` ``) or
  validating an Apollo account's length against the same constant `splitDualLinkKey` uses
  internally can now import both directly from `@ancientpantheon/pythia-client`.
- No removals, no breaking changes to any existing export.

## 2.5.0 — 2026-08-01

- **Added: `splitDualLinkKey`** — validates and splits a composite on-chain `dual-link-key`
  (`<standard-apollo>|<smart-apollo>`, the literal `PYTHIA|T|DualLinks` table key, 325 chars) into
  its two Apollo-account halves. A straight port of the existing, already-tested logic private to
  the Pythia service, now published for any consumer that has a pasted-in `dual-link-key` to work
  with. Throws `PythiaConnectorValidationError` (the existing "caller/environment input problem"
  class — reused, not a new taxonomy branch) with a message naming the specific problem: wrong
  total length, a missing/misplaced separator, or a half that doesn't start with the expected ₱/Π
  codepoint — genuinely useful to show a human in a settings-form validation flow, not a generic
  "invalid input."
- **Added: `DualLinkConnector`** — the class-shaped generalization of the Pythia service's own
  `SelfConnectorLoop` pattern for an arbitrary already-active dual-link pair. Constructed with a
  `dualLinkKey` (split — and validated — at construction time, so a malformed key fails fast,
  before any network call) plus a signer for each half, it holds two internal `PythiaConnector`s,
  ticks both on a schedule with per-half error isolation, and reports one usable `status()`: both
  halves' individual state, plus a single `secret`/`expiresAt` — whichever half currently has an
  active secret, since the gate never cares which half issued it. Also exposes `keyProvider()`
  mirroring `PythiaConnector`'s own, for direct `PythiaClientOptions.pythiaKey` wiring. Composes two
  real `PythiaConnector` instances internally rather than reimplementing the challenge/verify round
  trip, so every fix/behavior `PythiaConnector` already has (in-flight-refresh dedup, the full typed
  error mapping, refresh-margin caching) is inherited for free.
- This is the reusable primitive any consumer — not just Pythia's own self-connector — needs to
  actually USE an already-active on-chain dual-Apollo identity, without re-deriving this logic from
  scratch. See `docs/work/pythia-client-dual-link-sdk/{design,plan}.md`.
- No removals, no breaking changes to any existing export.

## 2.4.3 — 2026-08-01

Version alignment: the client jumps from `2.4.2` to `2.4.3` to align with the unified Pythia
service version line. This release fixes the actual on-box deploy failure (a `Dockerfile` runtime
stage bug — see `CHANGELOG.md` at the repo root) — no changes to this package's own source, API
surface, or behavior.

## 2.4.2 — 2026-07-31

Version alignment: the client jumps from `2.4.1` to `2.4.2` to align with the unified Pythia
service version line. This release is service-side only (a `SealedStore.rotateMasterKey`
hardening fix — see `CHANGELOG.md` at the repo root) — no changes to this package's own source,
API surface, or behavior.

## 2.4.1 — 2026-07-31

Version alignment: the client jumps from `2.4.0` to `2.4.1` to align with the unified Pythia
service version line. This release is a CI-only fix on the service side (the ghcr image build
workflow now builds `pythia-client` before running the test gate — see `CHANGELOG.md` at the repo
root) — no changes to this package's own source, API surface, or behavior.

## 2.4.0 — 2026-07-31

Version alignment: the client jumps from `2.3.0` to `2.4.0` to align with the unified Pythia
service version line. This release is service-side only (Pythia adopting the connector SDK as her
own third organ, plus a self-connector identity — see `CHANGELOG.md` at the repo root) — no changes
to this package's own source, API surface, or behavior.

## 2.3.0 — 2026-07-31

Version alignment: the client jumps from `1.7.0` to `2.3.0` to align with the unified
Pythia service version line (see `CHANGELOG.md` at the repo root and
`docs/RELEASING.md` — one version, mirrored across the service and this package).

- **Added: `PythiaConnector`** — the consumer-side orchestrator for Pythia's headless
  connector-auth protocol (`docs/work/pythia-connector-protocol/design.md`). Drives
  the full challenge → sign → verify round trip against an injected `ApolloSigner`
  (this package never holds key material or signs anything — the same "caller signs,
  we relay" philosophy `send()` already follows) and an injected `SecretStorage`
  (defaults to the new `InMemorySecretStorage` if none is supplied). `ensureSecret()`
  is pull-based: returns a cached still-valid secret with no network call, or
  transparently re-runs the round trip when there isn't one. Returns a typed
  `ConnectorSecretResult` — `{status:"active", secret, expiresAt}` on success, or
  `{status:"pending"}` (not a thrown error) when the account's ownership is proven but
  its on-chain dual link isn't active yet.
- **Added: `PythiaConnectorError` taxonomy** — `PythiaConnectorValidationError` (400),
  `PythiaConnectorSignatureError` (401), `PythiaConnectorNotLinkedError` (403),
  `PythiaConnectorUnavailableError` (502), all rooted under `PythiaConnectorError`,
  mirroring the existing `PythiaClientError` taxonomy's shape but scoped to the
  connector protocol's own, separate wire contract.
- **Added: `PythiaClientOptions.pythiaKey`** — a static string or a live supplier
  function (e.g. `connector.keyProvider()`), resolved fresh on every request and sent
  as the `x-pythia-key` gated-access header on `read`/`send`/`poll`. Omitted, or
  resolving to `undefined`, sends no header at all — no change to existing anonymous
  access.
- **Added: `SecretStorage` interface + `InMemorySecretStorage`** — the injection point
  for persisting the ephemeral secret across a consumer's own process/vault lifecycle.
- No removals, no breaking changes to any existing export.

## 1.7.0 — 2026-07-15

Version alignment: the client jumps from `1.1.0` straight to `1.7.0`,
skipping `1.2.0`–`1.6.0`, to align with the unified Pythia service version
line. No API changes — this is a version-only release; the service and the
client are now released together from a single git tag.

## 1.1.0 — 2026-07-05

The Pythia gateway pivots from a decode-baked read-only service to a keyless
generic transport gateway; the SDK surface is reshaped to match (pre-adoption —
no downstream consumers yet).

- Removed: `getBalance`, `getConfirmations`, and `rpc` methods, plus the
  `Balance` and `Confirmations` response types. The gateway no longer decodes
  chain data.
- Added: `read({ chainId?, code, data?, sender? })` — a generic dirty read; the
  caller supplies the Pact code and the node response is returned verbatim.
- Added: `send({ chainId?, cmds })` — a keyless broadcast that relays the
  caller-SIGNED `cmds` array to the node's `/send` verbatim. The client holds no
  keys and signs nothing.
- Added: `poll({ chainId?, requestKeys })` — per-request-key tx status,
  returning a typed `PollResult` (`{ chainId, finalityDepth, results }`).
- `health()` is unchanged. The client-side typed error taxonomy
  (`PythiaClientError` root + `PythiaValidationError` /
  `PythiaUnsupportedChainError` / `PythiaPoolExhaustedError`) and the `code`
  discriminator remapping are unchanged.

## 1.0.1 — 2026-07-05

- License: adopt the AncientHoldings proprietary license (all rights reserved),
  matching the AncientPantheon family (`@ancientpantheon/khronoton-core`). The
  `LICENSE` file now ships inside the published package tarball.
- Docs: point the usage example at the live gateway
  (`https://pythia.ancientholdings.eu`). No API change.

## 1.0.0 — 2026-07-04

First public release.

- `PythiaClient` class over a configurable `baseUrl` with an injectable
  `fetchImpl`, wrapping the four gateway endpoints: `getBalance`,
  `getConfirmations`, `rpc` (verbatim node relay), and `health`. The client
  always sets `chain=stoachain` itself.
- Client-side typed error taxonomy mirroring the service: `PythiaClientError`
  (shared root) + `PythiaValidationError`, `PythiaUnsupportedChainError`, and
  `PythiaPoolExhaustedError` (carrying `failures[]` + optional `chainId`).
- Typed response shapes: `Balance`, `Confirmations`, `HealthSnapshot` (amounts
  are decimal strings).
- Dependency-light: no runtime dependencies — rests only on the runtime `fetch`
  and its own types. Publishable package shape established: `sideEffects: false`,
  public `publishConfig`, provenance-signed publish via the tag-triggered
  workflow.
- README `## Status` + version-history and this changelog held at `1.0.0`
  parity to satisfy the publish version-gate.
