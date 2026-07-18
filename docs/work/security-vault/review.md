# security-vault — Review

Scope: the feature diff — `apps/pythia/src/admin/sealedVault.ts` (+test),
`settingsStore.ts` (+test), `routes.ts` + `securityRoutes.test.ts`, `index.ts`,
`public/{admin.js,admin.html,styles.css}`, the 1.10.0 version bump, `CHANGELOG.md`,
`docs/OPS-master-key.md`.

Lenses (4 — 4–15 code files, touches crypto/auth/input): correctness, security,
conventions, tests. Dispatched as parallel `nectar:lens` agents.

## Findings & resolution

**SECURITY — 0 findings.** Independent confirmation: AES-256-GCM with a 256-bit key +
96-bit IV, a fresh random IV and scrypt salt per seal (IV reuse structurally
impossible), auth tag stored and set before `final()` (bad tag → caught → `null`, never
a silent accept), status output carries no secret material, the plaintext secret never
reaches disk or browser when sealing, both endpoints gated by the same `gate`
middleware as `/admin/pyth`, the fingerprint is one-way `sha256`, and no keyless-banned
symbol is referenced.

| # | Sev | Finding | Verdict | Resolution |
|---|-----|---------|---------|------------|
| 1 | MEDIUM | `rotateMasterKey` re-seals but leaves the in-memory key stale → same instance then reads `null` / "locked" | CONFIRMED (latent trap; documented ops flow exits the process, but the postcondition is broken for any live caller) | Fixed — `masterKey` made mutable; the instance adopts `newKey` after a successful rotate. Test now asserts same-instance coherence. |
| 2 | MEDIUM | The wrong-old-key data-loss guard in `rotateMasterKey` had no test | CONFIRMED | Fixed — added a test asserting it throws and leaves the creds intact under the original key. |
| 3 | LOW | `SealedVault.has()` public but only called internally | CONFIRMED | Fixed — made `private`. |
| 4 | LOW | The locked/wrong-key fallback untested at the `SettingsStore` level | CONFIRMED | Fixed — added a store test: wrong key → `hubConfig()` null, `hasSecret()` false, mode "locked". |
| 5 | LOW | `GET /admin/security` test re-asserted the injected fixture fields | CONFIRMED | Fixed — reduced to a `toEqual(SEALED)` verbatim pass-through assertion. |
| 6 | LOW | `loadSecurity` returns silently on a non-OK response (stale panel) | REFUTED (by convention) | Declined — every sibling loader (`loadEarnings`, `loadHubStatus`, `loadVerifiers`) uses the same silent `if (!res.ok) return;`; fixing only this one breaks the symmetry. |

## Behavioral verification
- Vault crypto, sealing/migration/fallback, and the gated API are covered by 28 unit
  tests across the three touched files (round-trip across cold reload, no-plaintext-on-
  disk, wrong-key→locked, migration+strip, rotate + guard, gate 401/403).
- UI render path checked offline against the live CSS (the gate needs a real OIDC
  ancient session, which only the deploy has): the `#security` view revealed and
  populated in-browser resolved the badge to the exact theme tokens (`--gold`
  `rgb(230,190,106)` sealed / `#f0b34d` warn), cred rows to `--line` borders. The gated
  click-through + Clear-vault confirm reuse the already-proven shared `confirmDialog`
  and the unit-tested endpoints — verified end-to-end on the live deploy.

## Clean pass
- `npm test -w @ancientpantheon/pythia` → **359 passed (52 files)**.
- client `npm test` → **42 passed**. `tsc --noEmit` clean. `tsc -p tsconfig.build.json`
  clean. `node --check public/admin.js` OK. `versionConsistency.test.ts` → 2 passed.
- Round count: 1 lens round → 5 fixes (2 MEDIUM, 3 LOW) → terminal full-suite green.
