# container-ci — Review

Round 1. Scope: commit `522640f` (the two-artifact release lane + versioning gate) plus the
cross-repo `map.json` edit. Lenses: correctness, tests, conventions, security (4-lens tier).
Every finding adversarially validated against the real code before fixing.

## Findings

### [HIGH] image.yml had no version gate — ghcr push not held to the unified version — FIXED
- **Where:** `.github/workflows/image.yml`
- **Evidence:** the job ran only checkout → buildx → login → metadata → build-push; no `npm test`
  or tag/version check. `publish.yml` gates the npm publish on `npm test` (which runs the
  version-consistency test), but the container had no equivalent, so a `version.ts` drift that
  correctly fails `publish.yml` would still push `ghcr.io/ancientpantheon/pythia:X.Y.Z` with a stale
  baked-in `/healthz` version.
- **Verdict:** CONFIRMED (verified image.yml had no gate; Dockerfile runs no tests either).
- **Resolution:** added a version gate before build-push — `setup-node` + `npm ci` + a tag↔unified
  check (guarded to tag pushes) + `npm test` (reuses `versionConsistency.test.ts` rather than
  duplicating the rule). A drift now blocks the container exactly as it blocks the npm publish.

### [HIGH→hardening] Tag/version spliced into `run:` via `${{ }}` — FIXED
- **Where:** `.github/workflows/publish.yml` (README/CHANGELOG-parity step + publish step)
- **Evidence:** `TAG_VERSION="${{ steps.version.outputs.TAG_VERSION }}"` substituted into the shell
  script body.
- **Verdict:** CONFIRMED as a defence-in-depth fix. Adversarial note: the exploit is **already
  blocked** in practice — `versionConsistency.test.ts` asserts every version matches
  `/^\d+\.\d+\.\d+$/` and runs in the "Typecheck + Build + Test" step *before* these steps, so a
  crafted non-semver version fails the job first. Fixed anyway because the mitigation was implicit
  (relied on step ordering) and the fix is cheap/standard.
- **Resolution:** version now passed via `env:` (never substituted into script text); added an
  explicit semver guard in the `id: version` step so the guarantee is local to `publish.yml`.

### [MEDIUM] CHANGELOG.md + publish.yml referenced a non-existent test path — FIXED
- **Where:** `CHANGELOG.md` (×2), `.github/workflows/publish.yml` (×2)
- **Evidence:** referenced `tests/changelog-version.test.ts` (Mnemosyne's path); the real file is
  `apps/pythia/src/versionConsistency.test.ts` (`RELEASING.md` already had it right).
- **Verdict:** CONFIRMED (leftover from copy-adapting Mnemosyne; no `tests/` dir exists).
- **Resolution:** all four references corrected.

### [LOW] Version-parity greps used unescaped dots — FIXED
- **Where:** `.github/workflows/publish.yml` (three ERE greps)
- **Evidence:** `${TAG_VERSION}` interpolated into an ERE, so each `.` matched any char (e.g. `1X7X0`
  would satisfy the match) — only ever more permissive, never stricter.
- **Verdict:** CONFIRMED (LOW; pre-existing, but in a file already being edited).
- **Resolution:** escape dots via `TAG_VERSION_RE="${TAG_VERSION//./\\.}"` used in all three greps.

## Clean pass
- Correctness: fixed (image.yml gate). Tests: clean (0 findings — both test files verify real
  behavior). Conventions: fixed (path drift). Security: fixed (env indirection + semver guard).
- Post-fix verification (after the last edit): both workflows parse as valid YAML;
  `npm test` → `apps/pythia 248 passed (41 files)`, `pythia-client 42 passed (6 files)`;
  `npm run typecheck` OK; `npm run build` OK.
- **Behavioral note:** the release flow cannot be exercised fully without pushing a `v*` tag
  (owner's call — deliberately deferred). The gate both workflows invoke — `versionConsistency.test.ts`
  — passes locally, so the gate logic is verified; the actual ghcr push / npm publish is unexercised
  by design.

Rounds: 1. All CONFIRMED findings fixed; re-verified green.
