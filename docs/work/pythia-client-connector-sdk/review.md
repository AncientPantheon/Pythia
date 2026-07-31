# pythia-client-connector-sdk — Review

Scope: all 6 plan.md tasks (Topic 3 of pythia-connector-protocol) — `packages/pythia-client/src/
{connector,connectorErrors,secretStorage}.ts(+.test)`, `packages/pythia-client/src/{transport,
types,index}.ts` (additive `pythiaKey` wiring + new exports), `packages/pythia-client/src/
connectorIntegration.test.ts`, plus the version bump (4 files) + both CHANGELOGs + README. This is
the actual consumer-integration surface — the published SDK a consumer automaton depends on — so
weighted correctness and security heavily, plus explicit CI-gate verification (the publish
workflow's own documentation-parity greps, dry-run locally before considering this done).

## Round 1 — full-scope pass (correctness / security / conventions / tests lenses)

- **[MEDIUM] No in-flight-refresh dedup: concurrent `ensureSecret()` calls each fire their own
  challenge+verify round trip.** Two callers racing `ensureSecret()` (e.g. two simultaneous
  `PythiaClient` requests both consulting one shared `connector.keyProvider()`) both read
  `storage.load()` before either writes back and each independently calls `refresh()` — wasteful
  duplicate network calls and duplicate signer invocations (the signer may be
  expensive/rate-limited/user-facing, e.g. a wallet prompt). CONFIRMED (adversarially validated;
  traced through to `AuthNonceStore` to confirm both round trips independently succeed rather than
  one failing the other — wasteful, not fatal). **Fix:** added a memoized `refreshing: Promise<
  ConnectorSecretResult> | null` field; `refresh()` returns the same in-flight promise to
  concurrent callers, cleared in a `finally` (including on failure, so one failed refresh doesn't
  wedge every later call). New tests: concurrent calls share exactly one round trip
  (challenge/verify/signer call-count assertions); a failed refresh doesn't block a later, separate
  attempt from succeeding.
- **[MEDIUM] Challenge-leg error handling collapses ANY non-200 status into
  `PythiaConnectorValidationError`,** unlike the verify leg's careful per-status `switch`. A
  transient 502/503 or an HTML gateway error page on `/connectors/auth/challenge` would be
  reported as "invalid apollo account" — a misleading, non-retryable-sounding error for what's
  actually a transient failure the design's own taxonomy exists to distinguish. CONFIRMED
  (adversarially validated — confirmed `Transport.parseBody`'s own doc comment already anticipates
  gateway 5xx/HTML bodies reaching the client, so the SDK author was aware of the scenario but
  hadn't applied it to this leg). **Fix:** challenge-leg handling now mirrors the verify leg's
  care — 400 maps to `PythiaConnectorValidationError`; any other unexpected status throws the base
  `PythiaConnectorError` naming the real status, never mislabeled as a validation error. New test:
  a 502 challenge response throws a non-`PythiaConnectorValidationError` whose message names the
  real status.
- **[MEDIUM] `keyProvider()`'s error-swallow forces every failure through an unconditional,
  un-interceptable `console.error`**, including errors from a consumer's OWN injected `signer`/
  `storage` implementations (both documented bring-your-own points) — with no way to redact/filter/
  route before it reaches a global `console.error` call, which production log
  aggregators/APM/crash-reporting tooling commonly capture verbatim. Also surfaced a genuine
  doc/implementation mismatch: the doc comment claimed to catch only `PythiaConnectorError`, but
  the actual `catch` had no `instanceof` filter. CONFIRMED (adversarially validated — traced the
  full call path confirming a consumer's `signer.sign()`/`storage.load()`/`storage.save()`
  rejection really does propagate uncaught into this same catch). **Fix:** added
  `PythiaConnectorOptions.onKeyProviderError?: (error: unknown) => void`, defaulting to
  `console.error`; `keyProvider()`'s catch now calls this hook instead of the hardcoded global, and
  its doc comment now accurately describes catching ANY error (not just this SDK's own taxonomy).
  New tests: a custom `onKeyProviderError` receives the error INSTEAD of the default
  `console.error` firing; an error thrown by the caller's own injected signer is routed through
  the hook too, not just this SDK's own error types.
- **[HIGH] `storage.clear()` on a 202 "pending" verify response was never actually proven to
  run** — the only existing test used a connector whose storage started empty, so it couldn't
  distinguish "clear() ran" from "clear() was never called." CONFIRMED. **Fix:** new test seeds a
  real stored secret via a prior successful `refresh()`, then drives a second `refresh()` to 202
  and confirms a subsequent `ensureSecret()` no longer hands back the stale secret (proving
  `clear()` actually executed, not just that storage was never populated).
- **[HIGH] `refreshMarginMs` boundary logic had zero test coverage** — the only caching test used
  an `expiresAt` an hour out against the default 5-minute margin, nowhere near the boundary the
  condition actually guards. CONFIRMED. **Fix:** new test seeds a cached entry INSIDE the refresh
  margin (3 of 5 minutes left) and confirms `ensureSecret()` performs a real refresh rather than
  treating it as still-valid.
- **[MEDIUM] `Transport.postJson()`'s "no pythiaKey → no header" path was untested** — `get()` and
  `postJson()` build their headers with two different code shapes, but only `get()`'s
  no-option case had a test. CONFIRMED. **Fix:** new test exercises `postJson()` specifically.
- **[MEDIUM] Empty-string `pythiaKey` (static or supplier-resolved) was never exercised** — the
  "non-empty string" contract relies on a truthiness check that happens to satisfy `""` today, but
  nothing proved it. CONFIRMED. **Fix:** new test covers both a static `""` and a supplier
  resolving to `""`, both asserting no header is sent.
- **[MEDIUM] `bodyErrorMessage`'s defensive non-object-body fallback branch was never
  exercised** — every existing stubbed error body was a well-formed `{error: string}`. CONFIRMED.
  **Fix:** new test feeds a mapped-error verify status an HTML (non-JSON-object) body and confirms
  the thrown error's message is the hardcoded fallback, not a crash or `"undefined"`.
- **[LOW] `keyProvider()`'s legitimate-pending (202) branch was never directly tested** —
  indistinguishable in the existing suite from the error-swallow path. CONFIRMED. **Fix:** new
  test confirms a 202 resolves `keyProvider()`'s closure to `undefined` WITHOUT logging (unlike the
  genuine-error case, which does log), proving these are handled as two distinct paths.
- **[LOW] `connectorErrors.test.ts` never asserted a subclass is `instanceof` ITSELF** (only the
  root/`Error`). CONFIRMED. **Fix:** added the per-subclass self-instanceof assertions.
- **[LOW] `index.ts`'s new type export collapsed onto one line**, the only such export in the file
  (every sibling multi-name export is one-name-per-line). CONFIRMED. **Fix:** reformatted to match.
- **[LOW] `pythiaKey`'s field doc comment was disproportionately dense next to its undocumented
  siblings (`baseUrl`/`fetchImpl`) in the same interface.** CONFIRMED. **Fix:** trimmed to a
  one-liner pointing at `Transport.resolvePythiaKey`'s doc comment, which already carries the
  detail (matches the file's existing "document once, at the point of implementation" pattern).
- **Security lens, remainder:** no findings beyond the `console.error` one above — confirmed no
  CRLF/header-injection risk (Fetch's `Headers` rejects control characters before a request is
  sent), confirmed `buildUrl()` never accepts caller-influenced paths (so `x-pythia-key` can never
  be redirected to an unintended host), confirmed no code path echoes the raw secret into a thrown
  error or log call.
- **Conventions lens, remainder:** `connectorErrors.ts` confirmed to faithfully mirror `errors.ts`'s
  exact shape; `connector.ts`'s `Transport` usage confirmed consistent with `client.ts`; both
  CHANGELOGs and the README confirmed to follow `docs/RELEASING.md`'s bracket-vs-no-bracket format
  exactly, with all four version-bearing files agreeing at `2.3.0`.

## Verification (after the last edit)

- `npm test -w @ancientpantheon/pythia-client` → **76 passed (10 files)**.
- `npm run typecheck -w @ancientpantheon/pythia-client` clean. `npm run build -w
  @ancientpantheon/pythia-client` clean.
- `npm test -w @ancientpantheon/pythia` (whole-repo suite, includes `versionConsistency.test.ts`)
  → **511 passed (75 files)** — confirms all four version-bearing files and the root CHANGELOG's
  newest entry agree at `2.3.0`.
- `publish.yml`'s own three documentation-parity greps dry-run locally against `2.3.0` — README
  `## Status` line, README `**v2.3.0**` version-history paragraph, `CHANGELOG.md` first `##`
  heading — all three **PASS**, the exact gate that would otherwise fail the real workflow.

Rounds: 1 (terminal, full-scope, 4-lens pass, all findings caught in the first pass since this was
a from-scratch build reviewed once complete rather than iterated in rounds like Topics 1/2).
2 HIGH + 6 MEDIUM + 4 LOW fixed, all adversarially validated where the finding's correctness wasn't
self-evident (the three substantive design findings: in-flight dedup, challenge-status handling,
error-hook redaction). Zero STYLISTIC findings raised. Terminal state: full suite green,
typecheck/build clean, zero unresolved CONFIRMED findings, all CI documentation gates verified to
pass locally before commit.
