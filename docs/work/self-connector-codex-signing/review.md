# self-connector-codex-signing — Review

Scope: all 7 plan.md tasks — `apps/pythia/package.json`/`package-lock.json` (dependency bump),
`apps/pythia/src/automaton/{codexApolloSigner,codexApolloFixtures,selfApollo,selfConnectorLoop}.ts
(+.test)`, `apps/pythia/src/admin/routes.ts(+.test)`, `apps/pythia/src/index.ts`,
`apps/pythia/public/admin.{html,js}`, `apps/pythia/src/selfConnectorIntegration.test.ts`, and
`websites/Pantheon/docs/pantheonic-architecture/organs/06-pythia-client-wire-in.md` (+ its
CHANGELOG). This topic is a security-custody redesign — Pythia stops generating/holding her own
Apollo private key material entirely, delegating to her own Codex organ's `autoSignApolloChallenge`
instead — so weighted security and correctness heavily, alongside the usual conventions/test passes.

## Mid-build fix (found during T5's build, before any review lens ran)

`admin/routes.test.ts` and `selfConnectorIntegration.test.ts` (T3/T4) both initially imported
`encryptStringV2` from `@stoachain/stoa-core/crypto` directly, to build realistic test fixtures.
This trips `apps/pythia/tests/keyless-invariant.test.ts`'s "imports nothing from @stoachain/*
except the keyless dalos-crypto verify primitive" check — a DIFFERENT check from the sibling one a
few lines above it in that same file: this one has NO `*.test.ts` filename exemption, only a
directory exemption for `automaton/`. Both offending files live outside `automaton/`. **Fix:**
extracted the fixture-seeding helper into a new `apps/pythia/src/automaton/codexApolloFixtures.ts`
(inside the exempt directory, with a doc comment explaining exactly why it lives there), and had
both test files import `seedCodexWithRealPair` from it instead of calling `encryptStringV2`
themselves. Verified via `keyless-invariant.test.ts` going green and a full-repo grep confirming no
`@stoachain/*` import survives outside `automaton/` anywhere in this topic's changes.

## Round 1 — full-scope pass (correctness / security / conventions / tests lenses)

- **[MEDIUM] (conventions + correctness, independently found by BOTH lenses — a strong signal it's
  real) The Self Connector panel still showed "not yet generated" placeholder text for the account
  fields, contradicting the panel-note directly above it (already correctly rewritten this topic to
  say "Generate and activate this pair using the Codex tab first").** An operator viewing an unlinked
  panel would see text implying PYTHIA generates something — exactly false, and exactly the kind of
  leftover-feature confusion this topic's own T6 plan text warned about (yet missed this specific
  string). CONFIRMED by both lenses independently. **Fix:** both fallback strings changed to "not yet
  linked"; the stale section comment above `selfConnectorHalfView` ("generation state → badge") also
  corrected to "linkage state," with a note that generation lives entirely in the Codex tab now.
- **[MEDIUM] (conventions) `codexHoldsAccount()` duplicated `loadSnapshot`'s read/parse/guard logic
  instead of reusing it** — the module's own doc comment and the plan both claimed "both exported
  functions call `loadSnapshot` fresh on every invocation," but `codexHoldsAccount` never actually
  called it; it re-implemented the same three-line sequence inline. Two independent copies of "turn
  `codex.loadBackup()` into a parsed snapshot" can silently drift if one is ever changed without the
  other. CONFIRMED (direct code comparison). **Fix:** added a `tryLoadSnapshot()` wrapper that
  delegates to `loadSnapshot()` (catching its throw and returning `null` instead) — now there is
  exactly one function that ever parses a Codex backup blob in this file.
- **[MEDIUM] (tests) No test exercised what happens when Codex's snapshot is cleared/decommissioned
  AFTER a successful `setDualLinkKey()` call but before (or between) ticks** — `setDualLinkKey` only
  validates `codexHoldsAccount` once, at paste time, and `SelfConnectorLoop` never re-validates
  later. `DELETE /admin/codex` (an existing, real, reachable route) can invalidate the signing
  material mid-flight in production, and nothing in this topic's test suite proved the resulting
  behavior degrades gracefully rather than crashing or silently misreporting. CONFIRMED. **Fix:**
  added a test in `selfConnectorLoop.test.ts` — link a real pair, decommission the codex via
  `clearCodex()`, then tick: confirms `tick()` resolves without throwing (never an unhandled
  rejection, per `DualLinkConnector`'s own per-half error isolation) and `status()` reports
  `"pending"` for both halves (never falsely "active," never a crash).
- **[LOW] (conventions) `codexApolloFixtures.ts`'s doc comment didn't explain why THREE other, near-
  identical copies of the same fixture logic still exist inside the same exempt `automaton/`
  directory instead of importing the new shared helper** — a future reader could reasonably expect
  every in-directory test to consolidate onto it and be confused to find otherwise. CONFIRMED
  (this was a deliberate, plan-sanctioned choice — T2/T3/T4 built in parallel, before this shared
  file existed, and the plan explicitly said "duplicate rather than cross-import" to keep those
  parallel tasks independent — but the shared file's own doc comment didn't say so). **Fix:** added
  a note explaining the duplication is deliberate and pre-dates this file, and flagging that a
  future fix to the `originMode`/`originCurve` fields needs checking all four copies, not just this
  one.
- **Correctness lens, remainder:** `createCodexApolloSigner`'s scope-mismatch guard confirmed correct
  (compares the per-call signed account against the closure-captured one, no bypass found);
  `setDualLinkKey`'s two `codexHoldsAccount` checks confirmed synchronous with no TOCTOU window
  within the method itself; `createSigner`'s "no dual-link-key set" check confirmed to happen inside
  `sign()`, not at construction time, matching how `SelfConnectorLoop.tick()` actually calls it;
  `index.ts`'s `codexStore`-before-`selfApolloVault` declaration order confirmed correct;
  `isSelfAccount`'s closure confirmed to still reference valid (now-derived) getters.
- **Security lens: zero findings.** Traced every error path in `codexApolloSigner.ts` for leaked
  key/password material (none found — only account address strings or generic messages ever
  interpolated); confirmed `codexHoldsAccount`'s `.address` field-matching against the real
  `IOuroAccount` type and `autoSignApolloChallenge`'s own lookup logic; confirmed `POST
  /admin/self-connector/link` stayed gated behind `ancient` auth (the `generate()` route removal
  didn't touch the gate); confirmed the retired `self-apollo-standard`/`self-apollo-smart` sealed
  entries are genuinely gone from all current source, never re-written, and that removing them
  doesn't widen a vault-compromise blast radius (Apollo signing now needs `codexBackup`+
  `codexPassword`, the SAME pair Kadena signing via `khronoton/keyResolver.ts` already exposed);
  confirmed the `@ancientpantheon/codex` `0.6.1`→`0.7.0` bump is genuinely additive (checked the
  installed package's own CHANGELOG and confirmed existing consumers `keyResolver.ts`/`codexAdmin.ts`
  use only unchanged types).
- **Test coverage lens, remainder:** `codexApolloSigner.test.ts`'s 6 tests confirmed to genuinely
  prove real cryptographic round trips (independent `Apollo.verify` checks, not just "didn't
  throw"); `selfApollo.test.ts`'s "half not held by codex" case confirmed tested symmetrically for
  both standard and smart; `admin/routes.test.ts`'s "REAL wiring" block confirmed to exercise the
  real `codexHoldsAccount` path through a real `CodexStore`, no shortcuts.

## Verification (after all fixes)

- `npx vitest run apps/pythia/src/automaton/codexApolloSigner.test.ts
  apps/pythia/src/automaton/selfConnectorLoop.test.ts apps/pythia/src/automaton/selfApollo.test.ts`
  → **26 passed (3 files)**.
- `node --check apps/pythia/public/admin.js` → clean.
- `npm run typecheck -w @ancientpantheon/pythia` → clean.
- `npm test -w @ancientpantheon/pythia` (whole-repo suite) → **556 passed (80 files)**.
- `npx vitest run apps/pythia/tests/keyless-invariant.test.ts` → all 15 checks pass, confirming the
  `@stoachain/*` import-scoping fix holds under the full suite too.

Rounds: 1 (terminal, full-scope, 4-lens pass — one finding, the stale placeholder text, was
independently confirmed by two separate lenses, a strong signal it was genuinely real rather than a
single reviewer's false positive). 3 MEDIUM (1 UI, 1 code-duplication, 1 test-coverage) + 1 LOW
(doc-comment clarity) fixed. Zero HIGH/CRITICAL findings, zero security findings. Terminal state:
full suite green, typecheck clean, zero unresolved CONFIRMED findings.
