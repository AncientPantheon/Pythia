# pythia-client-dual-link-sdk — Design

Topic 1 of `docs/work/pythia-dual-link-connector/design.md` — read that first for the umbrella
problem statement and the corrected activation-flow understanding this design depends on.

## Problem

A consumer that has already gotten a dual-Apollo pair active on-chain (via Codex + either a raw
`C_Link` or Pythia's own browser Link-verify flow) has, in hand, exactly one thing worth pasting
into a settings field: the on-chain `dual-link-key` (`<standard-apollo>|<smart-apollo>`, 325
chars — confirmed as the literal `PYTHIA|T|DualLinks` table key). Nothing published lets them do
anything with it. Splitting it (`splitDualLinkKey`) and orchestrating the resulting two
`PythiaConnector`s into one usable, displayable thing (`SelfConnectorLoop`'s pattern) both exist
today — but only as private code inside the Pythia service itself
(`apps/pythia/src/connectors/auth/dualLinkCache.ts`, `apps/pythia/src/automaton/
selfConnectorLoop.ts`). Every other consumer is left to reimplement this from scratch — which
already went wrong once, in several independently-confirmed ways, when Mnemosyne tried.

## Approach

Add two things to `@ancientpantheon/pythia-client`:

1. **`splitDualLinkKey(dualLinkKey: string): { standardApollo: string; smartApollo: string }`** —
   a straight port of the existing, already-tested logic in `dualLinkCache.ts` (325-char length
   check, `"|"` at the fixed offset, both halves individually shape-validated via the SDK's own
   `isStandardApollo`/`isSmartApollo`-equivalent — check whether these are already exported or
   need to be, during planning). Throws `PythiaConnectorValidationError` (the existing "caller/
   environment input problem" class — reused, not a new taxonomy branch) with a message naming
   what's wrong (wrong length / missing separator / a half that isn't a valid Apollo address
   shape) — this runs at UI-form-validation time, so the message needs to be genuinely useful to
   show a human, not a generic "invalid input."
2. **`DualLinkConnector`** — the class-shaped generalization of `SelfConnectorLoop`'s proven
   pattern: constructed with a `dualLinkKey` (split at construction time — a malformed key fails
   fast, at construction, not on the first tick) plus a signer for each half, it holds two internal
   `PythiaConnector`s, ticks both on a schedule (mirrors `SelfConnectorLoop`'s `tick()`/`start()`/
   `stop()` shape and per-half error isolation exactly — both halves are still worth proving/
   refreshing independently even though the pair is already active by construction, since it adds
   resilience if one half's connector hits a transient problem the other doesn't), and reports one
   status object: both halves' individual state, PLUS a single usable `secret`/`expiresAt`
   (whichever half currently has an active secret — the gate never cares which half issued it, so
   exposing "the first one that's ready" rather than requiring both is the more useful shape for a
   consumer that just wants a working key). Also exposes `keyProvider()` mirroring
   `PythiaConnector`'s own, for direct `PythiaClientOptions.pythiaKey` wiring.

**Naming and reuse decisions:**
- `PythiaConnectorValidationError` reused for `splitDualLinkKey`'s failures rather than a new error
  class — it's the same conceptual failure (bad caller input), and growing the taxonomy for a
  parsing-only concern adds a class consumers have to know about for no real benefit.
- `DualLinkConnector` composes two real `PythiaConnector` instances internally rather than
  reimplementing the challenge/verify round trip — every fix/behavior `PythiaConnector` already has
  (in-flight-refresh dedup, the full typed-error mapping, refresh-margin caching) is inherited for
  free, not re-earned.

## Acceptance criteria

- [ ] `splitDualLinkKey` round-trips a well-formed key (`standard + "|" + smart` reconstructed from
      the output equals the input) and rejects each malformed shape (wrong total length, missing/
      misplaced separator, a half that isn't `APOLLO_ACCOUNT_LEN` or doesn't start with `₱`/`Π`)
      with a distinct, clear error message per failure mode.
- [ ] `DualLinkConnector` constructed with a malformed `dualLinkKey` throws at construction, before
      any network call.
- [ ] With both halves' signers wired against a real (or faithfully stubbed) Pythia server, ticking
      `DualLinkConnector` drives both `/connectors/auth/challenge`+`/verify` round trips and its
      `status()` reports the resulting secret + expiry once at least one half succeeds.
- [ ] `keyProvider()` composes with a real `PythiaClient` exactly like `PythiaConnector.
      keyProvider()` already does (mirror `connectorIntegration.test.ts`'s proof pattern) — the
      live secret reaches an actual `x-pythia-key` header on a real request.
- [ ] Full existing `pythia-client` suite stays green; new code has real behavioral tests.
- [ ] Version bump + CHANGELOG, following the same `docs/RELEASING.md` procedure every prior
      release this session used.

## Out of scope

- Anything in `apps/pythia` itself (Topic 2 — TTL differentiation, the admin paste-in UI, refactoring
  `SelfConnectorLoop` to use this new SDK class instead of its own private duplicate).
- The Pantheon architecture doc update (also Topic 2, once the pattern is proven working).
