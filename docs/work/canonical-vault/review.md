# canonical-vault — Review

Scope: the 3 waves' files, already shipped to `main` in `3051521` with no prior review —
`apps/pythia/src/codex/{vault,sealedStore}.ts(+.test)`, `apps/pythia/src/admin/settingsStore.ts(+.test)`,
`apps/pythia/src/index.ts`, `apps/pythia/src/admin/routes.ts`, `apps/pythia/src/admin/securityRoutes.test.ts`
(9 files → correctness + security + conventions + tests lenses, dispatched in parallel, each
finding adversarially validated in a fresh context before any fix).

## Round 1 — the shipped code

### [CRITICAL] Security panel's `clear` wiped the whole shared vault, including Codex/Khronoton signing custody
- **Where:** `apps/pythia/src/index.ts` (security wiring), `apps/pythia/src/codex/sealedStore.ts` (`clear()`), `apps/pythia/src/automaton/codexStore.ts`
- Independently flagged by both the correctness and security lenses (CRITICAL / HIGH) — merged at CRITICAL.
- **Verdict:** CONFIRMED.
- **Fix:** `clear` now calls `settingsStore.setHubConfig({ hmacSecret: "" })` (scoped to the hub secret only) instead of the vault-wide `sealedVault.clear()`.
- **Regression test:** `securityRoutes.test.ts` — a new describe block wires `security.clear` exactly as `index.ts` does, against a REAL `SealedStore`/`SettingsStore` with a second entry standing in for Codex custody; asserts that entry survives a clear. Verified this test fails against the pre-fix wiring and passes against the fix.

### [HIGH] `rotateMasterKey`'s re-seal phase not atomic as a whole — mid-failure leaves a mixed-key vault
- **Where:** `apps/pythia/src/codex/sealedStore.ts`
- **Verdict:** CONFIRMED.
- **Fix:** split into PLAN (read-only) / STAGE (seal into `.tmp` siblings only, with cleanup-and-rethrow on failure) / COMMIT (rename all, only once every entry staged) phases — no live file is ever touched until every entry has successfully staged under the new key.
- **Regression test:** `sealedStore.test.ts` — sabotages one entry's `.tmp` path so staging fails after an earlier entry has already staged; verified this test fails against the pre-fix single-loop APPLY (the earlier entry gets renamed before the failure) and passes against the fix.

### [MEDIUM] Legacy plaintext hub secret never migrated/purged once a master key is introduced later
- **Where:** `apps/pythia/src/admin/settingsStore.ts`
- Independently flagged by both the security and correctness lenses — same root cause, same severity.
- **Verdict:** CONFIRMED.
- **Fix:** `migrateLegacyPlaintextSecret()` runs on every `load()` — if sealing is available and a plaintext secret is still present, it moves into the vault (without clobbering an already-sealed value) and is stripped from `settings.json`.
- **Regression test:** 3 new tests in `settingsStore.test.ts` — migrates on upgrade, doesn't clobber a newer sealed value with stale residue, no-op when nothing to migrate.

### [LOW] `seal`/`unseal` duplicated `ensureSodiumReady()`'s body instead of calling it
- **Where:** `apps/pythia/src/codex/vault.ts`
- **Verdict:** CONFIRMED.
- **Fix:** both now call `ensureSodiumReady()`.

### [MEDIUM → STYLISTIC] Atomic-write sequence duplicated between `set()` and `rotateMasterKey()`
- **Verdict:** STYLISTIC (real duplication, but a small, self-contained, easily-audited snippet — a preference call).
- **Status: left as-is** — user did not opt into extracting a shared helper. Still open if reconsidered later.

## Round 2 — follow-on from the Round-1 fix (terminal full-scope, full-lens-set re-review)

A full re-run of all 4 lenses over the same 9-file scope came back clean on correctness, tests, and
conventions, but security caught a real gap the CRITICAL fix itself introduced:

### [HIGH] Security-panel copy still claimed `clear` wipes "every sealed credential"
- **Where:** `apps/pythia/public/admin.html` (danger-zone copy + button label), `apps/pythia/public/admin.js` (confirm-dialog text), `apps/pythia/src/admin/routes.ts` (`SecurityAdminControls` doc comment + route handler comment)
- The Round-1 fix correctly narrowed `clear()`'s *behavior* to the hub secret only, but never updated the UI copy or code comments, which still said "every sealed credential" / "the sealed creds" — a false claim in exactly the incident-response UI, and a comment that could lead a future maintainer to reintroduce the whole-vault-wipe bug.
- **Verdict:** CONFIRMED.
- **Fix:** rewrote the confirm dialog (title/message/button label), the static HTML danger-zone paragraph + button label ("Clear vault" → "Clear hub secret"), and both `routes.ts` comments to state the hub-secret-only scope explicitly.

### [MEDIUM] Stale code comments in `routes.ts` — same root cause as above
- **Verdict:** CONFIRMED, fixed alongside the above.

### [MEDIUM] "Clear hub secret" button's enabled state still driven by whole-vault `sealedCount`, not hub-secret presence
- **Where:** `apps/pythia/public/admin.js`
- Caught by a focused round-3 check of the round-2 diff: the copy now accurately says "hub secret only," but the button stayed enabled/disabled based on the vault-wide count, so it could render clickable with nothing hub-secret-specific to clear (e.g. vault holds only Codex custody).
- **Verdict:** CONFIRMED.
- **Fix:** gates on `names.includes("hubHmacSecret")` instead of `sealedCount`.

### [LOW → STYLISTIC] All-caps "ONLY" in the new copy
- **Verdict:** STYLISTIC (the codebase does have a precedent for plain-text caps emphasis elsewhere in the same admin.html, so this isn't a clean convention violation).
- **Status: left as-is** — not applied.

## Verification (after the last edit)

- `npm test -w @ancientpantheon/pythia` → **446 passed (67 files)**.
- `tsc --noEmit` clean. `tsc -p tsconfig.build.json` clean. `node --check public/admin.js` OK.
- `npm run build` OK (pre-existing, unrelated CSS `@import`-order warning only).
- No JSDOM/browser test harness exists for `admin.js` in this codebase (consistent with the other
  admin-panel review rounds in this project) — the button-gating fix is a one-line, low-risk
  boolean-expression change matching the validated suggested fix exactly, verified by `node --check`
  + the full suite; not additionally unit-tested, per the codebase's existing convention for this file.

Rounds: 2 (round 1: 4 CONFIRMED fixed, 1 STYLISTIC declined; round 2: 3 CONFIRMED fixed — 1 caught by
the terminal full-scope pass, 1 by a follow-up focused pass on the round-2 diff — 1 STYLISTIC declined).
Terminal full-scope, full-lens-set pass: zero CONFIRMED findings remain. Suite green.

Two STYLISTIC findings remain open by the user's choice (not applied):
1. Duplicated atomic-write sequence between `set()` and `rotateMasterKey()`'s STAGE loop (`sealedStore.ts`).
2. All-caps "ONLY" in the new Security-panel copy (`admin.html`, `admin.js`).
