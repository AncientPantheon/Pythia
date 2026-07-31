# pythia-self-consumer — Review

Scope: all 7 plan.md tasks — `apps/pythia/src/automaton/{selfApollo,selfConnectorLoop}.ts(+.test)`,
`apps/pythia/src/connectors/self/inProcessFetch.ts(+.test)`, `apps/pythia/src/admin/{routes,
organVersions}.ts(+.test)`, `apps/pythia/src/index.ts` (composition wiring),
`apps/pythia/src/selfConnectorIntegration.test.ts`, `apps/pythia/public/{admin.html,admin.js}`,
`apps/pythia/src/invariants/keylessScanner.ts` (a fix surfaced mid-build, not originally planned).
First-time review of a genuinely new capability — Pythia generating and holding real Apollo private
key material for the first time, in a codebase whose whole prior architecture was built around
being strictly "keyless" — so correctness and security were weighted heavily throughout.

## Build-time gaps (found by the implementers themselves, not the review lenses)

Two real gaps surfaced during build, both fixed before review started:

- **`apps/pythia/src/invariants/keylessScanner.ts`'s "keyless" invariant test failed** the moment
  `selfApollo.ts` (which legitimately calls `Apollo.generateRandom()`/`Apollo.sign()`) was placed
  at its originally-planned location (`connectors/self/`) — outside the ONE directory
  (`automaton/`) the scanner exempts as the "keyed sovereign half." Not a scanner bug: the plan
  itself put the file in the wrong zone. **Fix:** relocated `selfApollo.ts` and (for the same
  reason — it drives real signing through the vault) `selfConnectorLoop.ts` into `apps/pythia/src/
  automaton/`, flat alongside the existing `codexStore.ts`/`codexAdmin.ts`, with every relative
  import fixed for the new depth.
- **The same scanner's isolation check also flagged the new TEST files** (`selfConnectorIntegration.
  test.ts`, the extended `admin/routes.test.ts`) for importing from `automaton/` — the scanner had
  an exemption for the composition root (`index.ts`/`server.ts`) but none for `*.test.ts` files,
  which can never be part of the deployed request-handling import graph (confirmed:
  `tsconfig.build.json` excludes `src/**/*.test.ts` from the compiled `dist` `npm start` actually
  runs). **Fix:** added a `*.test.ts` exemption to `collectTsFiles` (the shared file-walker every
  scan function uses), with a new regression test proving BOTH sides — the exemption works for a
  `*.test.ts` file, AND a same-shaped non-test file importing the same thing is still caught (the
  real isolation guarantee wasn't weakened, just correctly scoped).

## Round 1 — full-scope pass (correctness / security / conventions / tests lenses)

- **[HIGH] `SelfApolloVault.ensureGenerated()` had a check-then-act race that could silently
  overwrite already-generated key material, orphaning a real on-chain-paid public key.** Found
  independently by BOTH the correctness and security lenses (same root cause, both framings).
  The `store.has(entryName)` check and the later `store.set(entryName, ...)` write straddled a real
  `await import("@ouronet/dalos-crypto/registry")` yield point — two concurrent calls to
  `ensureGenerated()` (e.g. a double-click on the admin "Generate" button, or two admin tabs — the
  UI had no in-flight guard) could both observe "not yet generated," each mint a DIFFERENT random
  keypair, and the second `set()` would silently clobber the first. Per design.md, the admin
  manually pays real on-chain STOA to register whichever public account string the generate
  response displayed — a race here meant the losing response's account could be permanently
  orphaned (its private key gone from the vault forever, funds and registration stranded).
  Adversarially validated (CONFIRMED) across all 4 sub-claims: the singleton instance, the
  await-always-yields guarantee, the absence of any serializing guard in the request path, and the
  UI's missing button-disable. **Fix:** added an in-flight promise memo (`generating`, mirroring
  `PythiaConnector.refreshing`'s identical pattern in `packages/pythia-client`) so concurrent calls
  await the SAME generation instead of racing; cleared in a `finally` so a failed generation doesn't
  wedge later calls. Belt-and-suspenders: `admin.js`'s Generate button now disables immediately on
  click (was previously only hidden reactively after a response). New tests: concurrent
  `ensureGenerated()` calls share one generation (asserted via a `generateRandom` call-count spy);
  a failed generation doesn't block a later, separate attempt from succeeding.
- **[LOW] A self-signer never cross-checked that the `apolloAccount` it was asked to sign for
  actually matched the half it holds the key for** — it would just sign whatever message was built
  from the caller-supplied account string. Unreachable in the current wiring (each `PythiaConnector`
  always passes back its own configured account), but a silent trust gap in a signer whose whole
  purpose is to be the security boundary. CONFIRMED. **Fix:** `sign()` now compares `apolloAccount`
  against the held half's own account and throws a clear error on mismatch, rather than silently
  computing a signature that would just fail to verify on-chain later with no clear cause. Updated
  the existing "mismatched half" test (which previously asserted "signs, but doesn't verify") to
  assert the new, stronger up-front rejection instead.
- **[MEDIUM] `SelfConnectorHalfStatus`'s `"pending"` state was never exercised by any test** — the
  stub server in `selfConnectorLoop.test.ts` only ever answered 200 or 401, never the 202 the REAL
  server returns whenever an account isn't yet an active dual link (Pythia's own realistic starting
  state per design.md, and potentially the state she sits in for however long the manual on-chain
  step takes — not a rare edge case, the common one). CONFIRMED. **Fix:** added a `pendingAccount`
  stub option and a new test proving a 202 response is cached and reported as `{status:"pending"}`,
  not lost/miscategorized as `"not-generated"`.
- **[MEDIUM] "constructed once, reused across ticks" — an explicit plan.md T5 requirement — was
  never actually proven.** The only timer-driven test advanced through exactly one interval, so
  nothing distinguished "the connector is reused, its cached secret returned cheaply" from "a fresh
  connector (and empty secret storage) is rebuilt every tick, defeating the whole point of
  `PythiaConnector`'s own caching." CONFIRMED. **Fix:** added a two-interval test asserting zero NEW
  verify calls on the second tick (proving the first tick's cached, still-valid secret was reused).
- **[LOW] × 2, test-assertion strength** — the "not-yet-generated half rejects" test only checked
  *that* it threw, not *what* (a regression removing the specific guard clause would still pass via
  an unrelated `TypeError`); the per-half failure-isolation test only checked *that* `console.error`
  fired, not *which* half's name was logged (a bug always logging the wrong half would pass
  unnoticed). Both CONFIRMED. **Fix:** both assertions now check the specific message content.
- **Security lens, remainder:** no findings beyond the HIGH race above — confirmed raw `priv` key
  material is never logged, never returned from any admin-facing response (`selfConnectorStatus()`
  only ever surfaces public account strings + status enums), the new admin routes are gated by the
  exact same `ancient`-role middleware instance as every other admin route (not weaker), and
  `inProcessFetch`'s shortcut is only ever wired as an internal `fetchImpl` — never reachable from
  any untrusted client-request path.
- **Conventions lens:** no findings — `selfApollo.ts`'s dynamic-import pattern confirmed to mirror
  `apolloVerify.ts` exactly (its one deliberate divergence, throwing rather than failing closed, is
  explicitly documented and justified); `selfConnectorLoop.ts` confirmed to mirror
  `usageReporter.ts`'s tick/start/stop shape precisely; the flat `automaton/` placement (vs. a new
  subdirectory) confirmed consistent with the existing `codexStore.ts`/`codexAdmin.ts` precedent.

## Verification (after the last edit)

- `npm test -w @ancientpantheon/pythia` → **542 passed (79 files)**.
- `npm run typecheck --workspace=@ancientpantheon/pythia` clean. `npm run build
  --workspace=@ancientpantheon/pythia` clean (only the pre-existing, unrelated CSS `@import`-order
  warning from `@ancientpantheon/codex`'s `ui.css`).
- `apps/pythia/tests/keyless-invariant.test.ts` — all invariants (banned symbols, banned imports,
  automaton-core isolation, the new `*.test.ts` exemption + its own non-test-file counter-proof) —
  pass against the real, now-larger tree.

Rounds: 1 (terminal, full-scope, 4-lens pass). 1 HIGH (adversarially validated across all 4
sub-claims) + 1 MEDIUM×2 + 1 LOW×3 fixed. Zero STYLISTIC findings raised. Terminal state: full suite
green, typecheck/build clean, zero unresolved CONFIRMED findings.
