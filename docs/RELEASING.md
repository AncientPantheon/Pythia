# Releasing Pythia

Pythia follows [Semantic Versioning](https://semver.org). Unlike a single-artifact
project, Pythia ships **two artifacts from one version**:

- `@ancientpantheon/pythia-client` — the npm SDK consumers `npm install`.
- `ghcr.io/ancientpantheon/pythia` — the container image the gateway service runs from.

One version, one tag, two publish lanes. This doc is the procedure for cutting a
release without letting the two drift.

## The rule: one version, mirrored into four files, documented in two changelogs

Root `package.json`'s `version` is the **single source of truth**. It is mirrored,
byte-for-byte identical, into:

1. `package.json` (root) — the source of truth itself.
2. `packages/pythia-client/package.json` — the published npm package version.
3. `apps/pythia/package.json` — the service package version.
4. `apps/pythia/src/version.ts` (`PYTHIA_VERSION`) — read by the running service and
   surfaced at `GET /healthz` and the landing-page footer, so which build is live is
   verifiable at a glance after a deploy.

This is enforced: `apps/pythia/src/versionConsistency.test.ts` fails the suite if any
of those four disagree with each other, or with the newest `## [x.y.z]` entry in the
root `CHANGELOG.md` (see below). So a version bump that misses a file, or ships without
its changelog entry, cannot merge — `npm test` (which runs across all workspaces, this
test included) catches it before CI does.

**Every time you bump the version, add matching documentation in the same commit:**

- A `## [x.y.z] — YYYY-MM-DD` entry at the **top** of the root
  [`CHANGELOG.md`](../CHANGELOG.md) (bracket format) — the repo/service changelog,
  describing what changed for an operator (group by area, not commit-by-commit).
- A `## x.y.z — YYYY-MM-DD` entry at the **top** of
  [`packages/pythia-client/CHANGELOG.md`](../packages/pythia-client/CHANGELOG.md)
  (no-bracket format) — the client's own change history, describing what changed for
  a consumer of the SDK.
- A bump to `packages/pythia-client/README.md`: the `## Status` block must lead with
  a line containing `` `x.y.z` on public npmjs ``, and the version-history section must
  gain a `**vx.y.z**` paragraph. `publish.yml`'s parity gate greps for both.

Two changelogs exist because they serve different audiences: the root one documents
the repo/service (including the container image), the client one documents only the
published SDK's API surface. They share a version number but not a format — the root
uses `## [x.y.z]` (brackets, Mnemosyne-style), the client uses `## x.y.z` (no
brackets, its pre-existing convention).

## One tag, two workflows

Pushing a single `vX.Y.Z` git tag fires **both**:

- **`.github/workflows/publish.yml`** — publishes `@ancientpantheon/pythia-client@X.Y.Z`
  to npmjs.org (idempotent, `--provenance`, plus a GitHub Release). Its version gate
  checks the tag against the **unified** root `package.json` version (not the client's
  own, historically — that drifted). It also runs the full typecheck/build/test suite
  first, which includes `versionConsistency.test.ts`, so the four version files are
  re-verified to agree before anything is published.
- **`.github/workflows/image.yml`** — builds and pushes
  `ghcr.io/ancientpantheon/pythia:X.Y.Z` and `:latest` to GitHub Container Registry,
  using `docker/metadata-action`'s `type=semver` tag derived from the pushed tag.

Both workflows trigger on `push: tags: ["v*"]` independently — there is no dependency
between them, and either can fail without blocking the other. They are gated on the
same unified version because the tag is the same tag.

## Procedure

1. Land the feature/fix work (with its tests) on `main`.
2. Bump `version` in lockstep in all **four** version-bearing files:
   - `package.json` (root)
   - `packages/pythia-client/package.json`
   - `apps/pythia/package.json`
   - `apps/pythia/src/version.ts` (`PYTHIA_VERSION`)
3. Add the documentation for the bump, all in the same commit as the version bump:
   - A `## [x.y.z] — YYYY-MM-DD` entry at the top of root `CHANGELOG.md`.
   - A `## x.y.z — YYYY-MM-DD` entry at the top of
     `packages/pythia-client/CHANGELOG.md`.
   - The `## Status` line and version-history paragraph bump in
     `packages/pythia-client/README.md`.
4. Run the local check sequence and confirm both are green:
   - `npm run build`
   - `npm test` (runs across all workspaces, including
     `versionConsistency.test.ts` — this is the same gate `publish.yml` re-runs in CI)
5. Commit the version bump + both changelogs + the README together, e.g.
   `release: vX.Y.Z — <one-line summary>`.
6. Tag the commit `vX.Y.Z` and push the tag. This single push fires both
   `publish.yml` (npm) and `image.yml` (ghcr) from the same commit.
7. Confirm both workflow runs succeed: `@ancientpantheon/pythia-client@X.Y.Z` on
   npmjs.org, and `ghcr.io/ancientpantheon/pythia:X.Y.Z` + `:latest` on GHCR.

## Prerequisites

- **Org Actions permission (one-time, owner action):** the `AncientPantheon` org
  must allow Actions **"Read and write"** permissions
  (Settings → Actions → General → Workflow permissions). Without this, the ghcr
  push in `image.yml` is denied even though the workflow already declares
  `permissions: packages: write` — the org-level setting overrides the
  workflow-level grant.
- `NPM_PUBLISHER` secret must be set for `publish.yml`'s npm auth token.
  `image.yml` needs no secret — it uses the automatic `GITHUB_TOKEN`, nothing to
  rotate or expire.

## Notes

- Do NOT hand-edit the version in only one of the four files — a bump is not
  complete until all four agree, and `versionConsistency.test.ts` will fail the
  suite (and thus `npm test` in CI) until they do.
- ghcr packages published by Actions default to **private**. That's fine for now —
  the VPS builds its own image from source; ghcr exists for rollback. Making the
  package public is a separate, later decision (not required for a release).
- If a change has no user-visible effect (pure refactor, comment, test-only), fold
  it into the next real version's changelog entry rather than minting a version
  for it.
