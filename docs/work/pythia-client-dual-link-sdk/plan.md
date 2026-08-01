# pythia-client-dual-link-sdk — Plan

Design: `docs/work/pythia-client-dual-link-sdk/design.md`. Test command: `npm test -w
@ancientpantheon/pythia-client`. Package root: `packages/pythia-client`.

Read `apps/pythia/src/connectors/auth/dualLinkCache.ts` first — the existing, private
`splitDualLinkKey`/`APOLLO_ACCOUNT_LEN`/`PYTHIA_DUAL_LINK_BAR` this plan's T1 ports and extends
with validation (the existing one has NO shape validation — it's called only after its own caller
already checked the length; the new SDK version must validate everything itself, since it's fed
directly by pasted user input). Also read `apps/pythia/src/routes/connectorVerify.ts`'s
`isStandardApollo`/`isSmartApollo` (`a.codePointAt(0) === 0x20b1` / `0x03a0`) — mirror these exactly
(packages/pythia-client cannot import from apps/pythia; this is a small, deliberate, self-contained
duplication, not an oversight).

## Wave 1

- [ ] T1: `packages/pythia-client/src/dualLinkKey.ts` — validating `splitDualLinkKey` — done when:
      exports `const APOLLO_ACCOUNT_LEN = 162`, `const DUAL_LINK_BAR = "|"` (mirror the exact
      values from `dualLinkCache.ts`, with a doc comment noting they must stay byte-identical to
      the on-chain `CT_Bar`/account-length values), and:
      ```ts
      export interface DualLinkHalves {
        standardApollo: string;
        smartApollo: string;
      }
      export function splitDualLinkKey(dualLinkKey: string): DualLinkHalves;
      ```
      Validates, in this order, throwing `PythiaConnectorValidationError` (import from
      `./connectorErrors.js` — the existing class, reused, not a new one) with a message naming
      the SPECIFIC problem:
      1. Total length must be exactly `APOLLO_ACCOUNT_LEN * 2 + DUAL_LINK_BAR.length` (325) —
         else: `` `invalid dual-link-key: expected 325 characters, got ${dualLinkKey.length}` ``.
      2. The character at index `APOLLO_ACCOUNT_LEN` (162) must be `DUAL_LINK_BAR` — else:
         `` `invalid dual-link-key: expected "|" at position 162` ``.
      3. The first half (`dualLinkKey.slice(0, 162)`) must start with codepoint `0x20b1` (₱) — else:
         `` `invalid dual-link-key: the standard half must start with ₱` ``.
      4. The second half (`dualLinkKey.slice(163)`) must start with codepoint `0x03a0` (Π) — else:
         `` `invalid dual-link-key: the smart half must start with Π` ``.
      On success, returns `{ standardApollo: dualLinkKey.slice(0, 162), smartApollo:
      dualLinkKey.slice(163) }`.
      Tests (TDD, write first) in `packages/pythia-client/src/dualLinkKey.test.ts`:
      - A well-formed key built as `` `${standard}${DUAL_LINK_BAR}${smart}` `` (using real
        162-char `₱.`/`Π.`-prefixed fixtures) round-trips: `splitDualLinkKey(key)` returns exactly
        `{standardApollo: standard, smartApollo: smart}`.
      - Each of the 4 malformed shapes above throws `PythiaConnectorValidationError` with a message
        matching the specific text for THAT failure (not just "any error") — one test per shape,
        4 tests, each asserting via `.toThrow(/expected 325 characters/)` etc. (the specific
        substring for that case).
      - A key that's the right total length but has the separator in the wrong position (e.g. a
        stray `"|"` inside one of the halves shifting things, total length still 325) is still
        caught by check 2 (wrong position) even though check 1 (length) passes — construct this
        fixture explicitly, don't assume check 1 alone covers it.
  - files: `packages/pythia-client/src/dualLinkKey.ts`, `packages/pythia-client/src/dualLinkKey.test.ts`

## Wave 2 (depends on Wave 1)

- [ ] T2: `packages/pythia-client/src/dualLinkConnector.ts` — `DualLinkConnector` — done when:
      Read `packages/pythia-client/src/connector.ts` FIRST in full — `PythiaConnector`,
      `ApolloSigner`, `ConnectorSecretResult` are reused directly, not reimplemented. Exports:
      ```ts
      export type DualLinkHalfStatus =
        | { status: "pending" }
        | { status: "active"; secret: string; expiresAt: number };

      export interface DualLinkConnectorOptions {
        dualLinkKey: string;              // split via T1's splitDualLinkKey at construction
        baseUrl: string;
        standardSigner: ApolloSigner;
        smartSigner: ApolloSigner;
        fetchImpl?: typeof fetch;
        intervalMs?: number;              // default 3 * 60 * 60 * 1000 (3h) — same default PythiaConnector's own refresh margin assumes
        onError?: (half: "standard" | "smart", error: unknown) => void; // default: console.error(`dual-link-connector: the "${half}" half's tick failed —`, error)
      }

      export interface DualLinkStatus {
        standard: DualLinkHalfStatus;
        smart: DualLinkHalfStatus;
        secret: string | null;   // whichever half is currently active — standard preferred, smart as fallback; null if neither
        expiresAt: number | null;
      }

      export class DualLinkConnector {
        constructor(options: DualLinkConnectorOptions);
        tick(): Promise<void>;
        start(): void;
        stop(): void;
        status(): DualLinkStatus;
        keyProvider(): () => Promise<string | undefined>;
      }
      ```
      Constructor: calls `splitDualLinkKey(options.dualLinkKey)` (T1) FIRST — a malformed key
      throws immediately, before constructing anything else. Then constructs two internal
      `PythiaConnector`s (`apolloAccount: standardApollo`/`smartApollo`, `signer:
      options.standardSigner`/`smartSigner`, `baseUrl`, `fetchImpl` — each real `PythiaConnector`
      instances, not reimplemented logic).
      `tick()`: calls `ensureSecret()` on BOTH internal connectors independently (mirrors
      `SelfConnectorLoop.tick()`'s per-half isolation exactly — read `apps/pythia/src/automaton/
      selfConnectorLoop.ts` for the exact pattern to mirror: a per-half try/catch, one half's
      thrown `PythiaConnectorError` is caught + reported via `onError(half, error)` and does NOT
      prevent the other half's tick from running or throw out of `tick()` itself); caches each
      half's last-known `ConnectorSecretResult` into private `lastStandard`/`lastSmart` fields.
      `start()`/`stop()`: identical shape to `SelfConnectorLoop`'s (`setInterval(...).unref()`,
      idempotent start, clearing stop).
      `status()`: reads cached fields only, no network call. `standard`/`smart` map each cached
      result to `DualLinkHalfStatus` (`{status:"pending"}` before any tick or on a pending result;
      `{status:"active", secret, expiresAt}` once active). Top-level `secret`/`expiresAt`: if
      standard is active, use its secret/expiresAt; else if smart is active, use its; else both
      `null`.
      `keyProvider()`: returns a closure calling `ensureSecret`-equivalent behavior — actually:
      calls a private method that runs `tick()` then reads `status()`, returning `status().secret ??
      undefined` — catches any unexpected throw (shouldn't normally happen since `tick()` itself
      catches per-half errors, but defensive) and resolves `undefined` rather than rejecting, same
      contract as `PythiaConnector.keyProvider()`.

      Tests (TDD, write first) in `packages/pythia-client/src/dualLinkConnector.test.ts` (mirror
      `packages/pythia-client/src/connector.test.ts`'s `routedFetch`-by-pathname stub pattern, and
      `apps/pythia/src/automaton/selfConnectorLoop.test.ts`'s per-half-isolation test shapes, for
      style — both already reviewed/proven this session):
      - Constructing with a malformed `dualLinkKey` (e.g. wrong length) throws
        `PythiaConnectorValidationError` and constructs nothing else (no connector, no timer).
      - `tick()` against stub routes returning 200 for both halves: `status()` afterward reports
        both halves `active` with their respective secrets, and top-level `secret` equals the
        STANDARD half's secret (the preferred one) with matching `expiresAt`.
      - Stub route returns 200 for smart, 401 for standard: `status().standard` stays `{status:
        "pending"}`, `status().smart` is active, and top-level `secret`/`expiresAt` fall back to
        the smart half's values (proves the fallback-preference logic, not just "one is active").
      - `onError` is called with `("standard", <the thrown error>)` for the above case — assert the
        exact half name argument, not just that it fired.
      - `start()`/`stop()` timer behavior — mirror `selfConnectorLoop.test.ts`'s fake-timer tests
        (interval firing `tick()`-driven work, `stop()` halting further ticks, `start()` idempotent
        against a doubled timer).
      - A second `tick()` within the refresh margin does not re-fire the verify calls (proves reuse
        of the SAME internal `PythiaConnector` instances across ticks, not reconstruction — mirror
        `selfConnectorLoop.test.ts`'s equivalent regression test).
      - Integration: `keyProvider()` wired into a REAL `PythiaClient`'s `pythiaKey` option (mirror
        `packages/pythia-client/src/connectorIntegration.test.ts`'s exact pattern — real
        collaborators, fake only the network boundary) — a `client.read(...)` call carries the
        `x-pythia-key` header with the value `status().secret` resolved to.
  - files: `packages/pythia-client/src/dualLinkConnector.ts`, `packages/pythia-client/src/dualLinkConnector.test.ts`

## Wave 3 (depends on Wave 2)

- [ ] T3: Export the new surface + version/changelog/README — done when:
      `packages/pythia-client/src/index.ts` exports `splitDualLinkKey`, `type DualLinkHalves` (T1),
      `DualLinkConnector`, `type DualLinkConnectorOptions`, `type DualLinkStatus`, `type
      DualLinkHalfStatus` (T2) — mirror the existing export grouping style in that file (one name
      per line in multi-name blocks, per the existing convention already enforced this session).
      Root `package.json`, `packages/pythia-client/package.json`, `apps/pythia/package.json`, and
      `apps/pythia/src/version.ts` all bump to the same next version (confirm the exact current
      version at build time and bump the minor — this is additive new capability, no breaking
      change, same precedent as every prior release this session). `packages/pythia-client/
      CHANGELOG.md` gains a new top entry documenting `splitDualLinkKey` + `DualLinkConnector` (not
      a version-alignment-only entry — real new API this time). `CHANGELOG.md` at the repo root
      gains a matching `## [x.y.z]` entry. `packages/pythia-client/README.md`'s `## Status` line +
      a new `**vx.y.z**` version-history paragraph, per the same pattern every prior release this
      session followed — dry-run `publish.yml`'s 3 documentation-gate greps locally against the new
      version string before considering this done (same check every prior release ran).
      `npm run typecheck -w @ancientpantheon/pythia-client`, `npm test -w
      @ancientpantheon/pythia-client`, `npm run build -w @ancientpantheon/pythia-client` all clean.
      `apps/pythia`'s full suite (`npm test -w @ancientpantheon/pythia`) still green (its own
      `versionConsistency.test.ts` re-verifies the four-file/changelog agreement).
  - files: `packages/pythia-client/src/index.ts`, root `package.json`, `packages/pythia-client/package.json`, `apps/pythia/package.json`, `apps/pythia/src/version.ts`, `CHANGELOG.md`, `packages/pythia-client/CHANGELOG.md`, `packages/pythia-client/README.md`, `package-lock.json`
