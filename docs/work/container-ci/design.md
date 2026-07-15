# container-ci — Design

> Topic 1 of the **pythia-constructor-service** project. Foundation: make one `v*` git tag
> publish **both** Pythia artifacts on **one unified version**, gated by a changelog test.
> Reference: Mnemosyne's `.github/workflows/image.yml` + `tests/changelog-version.test.ts` +
> `docs/RELEASING.md` (all read; mechanics confirmed).

## Problem
Pythia ships two artifacts whose versions have drifted and whose release is half-wired:
- `@ancientpantheon/pythia-client` @ **1.1.0** (last git tag `v1.1.0`) — the npm client consumers import.
- `apps/pythia` service @ **1.6.0** (`version.ts` + its `package.json`) — the live container.
- Root `package.json` @ **0.0.0**.

The existing `.github/workflows/publish.yml` publishes **only the client**, and fails unless the
tag equals the *client* version. There is **no ghcr container image** (the VPS hand-builds from
source), **no root `CHANGELOG.md`**, and **no versioning gate** — so a version bump can merge with
no documentation and the two artifacts can silently diverge further.

## Approach
Adopt the blueprint's §10 versioning gate and §13 two-artifact / one-version rule, adapted to
Pythia's npm-workspace monorepo.

**Single source of truth = one version string, mirrored + test-enforced.** Root `package.json`
`version` is authoritative; `packages/pythia-client/package.json`, `apps/pythia/package.json`, and
`apps/pythia/src/version.ts` all carry the identical value. A new `tests/changelog-version.test.ts`
(ported from Mnemosyne, extended for the workspace) asserts **all four agree** AND equal the newest
`## [x.y.z]` entry in a new root `CHANGELOG.md`. First unified value: **1.6.0** (the client jumps
`1.1.0 → 1.6.0` to align with the service; owner-decided). The release that ships this topic bumps
to **1.7.0**.

**Two workflows, one tag.** Keep npm and ghcr as separate workflows that both trigger on `v*` — the
blueprint's shape — so one tag fires both lanes:
- **`publish.yml` (reworked)** — still publishes the client to npm (idempotent, `--provenance`,
  GitHub Release), but its version gate changes from "tag == *client* version" to "tag == *unified*
  version", and it additionally asserts the four-file version agreement so the lanes can't drift.
  The client's own `README`/`CHANGELOG` parity checks stay (the client version now equals the tag).
- **`image.yml` (new)** — copied from Mnemosyne verbatim, swapping `mnemosyne → pythia`, context `.`
  (Dockerfile already at repo root): `setup-buildx-action` → ghcr login with the automatic
  `GITHUB_TOKEN` → `metadata-action` (`type=semver,pattern={{version}}` + `type=raw,value=latest`)
  → `build-push-action` with `cache-from/to: type=gha`. Produces
  `ghcr.io/ancientpantheon/pythia:<semver>` + `:latest` for rollback presence.

**Alternatives considered:**
- *Merge npm + ghcr into one workflow* — rejected: two independent lanes with independent failure
  modes are clearer and match Mnemosyne; one tag already fires both.
- *Make `version.ts` read `package.json` at runtime* (drop the mirror) — rejected for now: a
  constant + a cheap equality test is simpler and matches how the value is imported today.

## Acceptance criteria
- [ ] Pushing a `v1.7.0` tag publishes `@ancientpantheon/pythia-client@1.7.0` to npm **and**
      `ghcr.io/ancientpantheon/pythia:1.7.0` + `:latest` to GHCR — from the same tag, no PAT
      (automatic `GITHUB_TOKEN`).
- [ ] Root `package.json`, `packages/pythia-client/package.json`, `apps/pythia/package.json`, and
      `apps/pythia/src/version.ts` all carry the identical version; the client has jumped to the
      unified line (no longer `1.1.0`).
- [ ] `tests/changelog-version.test.ts` fails the suite if any of those four diverge, or if the
      newest `CHANGELOG.md` `## [x.y.z]` entry doesn't equal them.
- [ ] A root `CHANGELOG.md` exists with a top entry matching the current version, and
      `docs/RELEASING.md` documents the one-tag / two-artifact / four-file-bump procedure.
- [ ] `image.yml` runs `setup-buildx-action` **before** `build-push-action` (required for the
      `type=gha` cache) and pushes with `${{ github.actor }}` + `GITHUB_TOKEN`.
- [ ] `npm run build` and the full `npm test` suite pass with the unified version in place; the
      keyless `keylessScanner` invariant still holds.

## Out of scope
- The card admin and the verifier registry (topics 2 and 3).
- Actually cutting a public release / pushing the tag — that's the owner's call after review.
- The on-box Deploy button and any Caddy blue-green work (deferred project-level).

## Prerequisites / risks (owner-facing, not code)
- **Org Actions permission:** the `AncientPantheon` org must allow Actions **"Read and write"**
  (Settings → Actions → General → Workflow permissions) or the ghcr push is denied even with
  `permissions: packages: write`. One-time org setting — owner action.
- Actions-published ghcr packages default to **private**. Fine for now (the VPS builds its own
  image; ghcr is for rollback). If anonymous `docker pull` is ever wanted, make the package public
  in its settings — not needed this topic.
