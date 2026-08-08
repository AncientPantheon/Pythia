# Releasing Pythia

Pythia follows [Semantic Versioning](https://semver.org). It ships **two artifacts on
TWO INDEPENDENT version lines** (changed in v3.0.0 — previously they were locked together):

- **SERVICE** — `ghcr.io/ancientpantheon/pythia` (the gateway/website container image).
  Its version is the git tag `vX.Y.Z`.
- **CLIENT** — `@ancientpantheon/pythia-client` (the npm SDK consumers `npm install`).
  Its version is **independent** and moves **only when the client's own source changes**.

> **The rule (v3.0.0+):** the client version STAYS PUT across service releases. A change
> to the website/gateway bumps the SERVICE only; the client is not touched or republished.
> The client version bumps **only** when `packages/pythia-client/src/**` actually changes.
> The two lines were baselined together at `3.0.0` and diverge from there.

## The two version lines

**SERVICE line** — mirrored, byte-for-byte, into four places, all equal to the tag:

1. `package.json` (root) — the service source of truth.
2. `apps/pythia/package.json` — the service package version.
3. `apps/pythia/src/version.ts` (`PYTHIA_VERSION`) — surfaced at `GET /healthz` + the
   landing footer, so the live build is verifiable at a glance.
4. The top `## [x.y.z]` entry in the root [`CHANGELOG.md`](../CHANGELOG.md) (bracket format).

**CLIENT line** — independent, self-consistent across three places:

1. `packages/pythia-client/package.json` — the published npm version.
2. The top `## x.y.z` entry in [`packages/pythia-client/CHANGELOG.md`](../packages/pythia-client/CHANGELOG.md)
   (no-bracket format).
3. The `` `x.y.z` on public npmjs `` status line **and** a `**vx.y.z**` history paragraph
   in `packages/pythia-client/README.md`.

Both are enforced by `apps/pythia/src/versionConsistency.test.ts`: it checks the SERVICE
quartet all agree, and (separately) that the CLIENT trio is internally consistent — but it
**does NOT require the client to equal the service**. So the two may legitimately diverge.

## One tag, two workflows — but the client publishes only when it changed

Pushing a `vX.Y.Z` git tag (the SERVICE version) fires both:

- **`.github/workflows/publish.yml`** — reads the client's OWN version from its
  `package.json` and publishes `@ancientpantheon/pythia-client@<client-version>`
  **idempotently**: if that version is already on npm (i.e. the client didn't change this
  release), it **skips**. So a service-only release does not republish the client. The tag
  is checked against the SERVICE version (root `package.json`); the client doc-parity greps
  check the CLIENT version.
- **`.github/workflows/image.yml`** — builds/pushes `ghcr.io/ancientpantheon/pythia:X.Y.Z`
  + `:latest` (the SERVICE), gated on `tag == service version`.

Both run the full `typecheck + build + test` (incl. `versionConsistency.test.ts`) first.

## Procedure — a SERVICE-only release (the common case)

1. Land the website/gateway work (with tests) on `main`.
2. Bump the SERVICE trio to the new `X.Y.Z`: `package.json` (root),
   `apps/pythia/package.json`, `apps/pythia/src/version.ts`. **Leave
   `packages/pythia-client/*` untouched.**
3. Add a `## [X.Y.Z] — YYYY-MM-DD` entry at the top of the root `CHANGELOG.md`.
4. `npm run build && npm test` — green (the gate confirms the service quartet agrees and
   the client is still internally consistent at its unchanged version).
5. Commit: `release: vX.Y.Z — <summary>`. Tag `vX.Y.Z`, push the tag.
6. Confirm: `image.yml` pushes the new image; `publish.yml` runs and **skips** the client
   publish ("client unchanged"). npm's `pythia-client` version does not move.

## Procedure — a release that ALSO changes the client

Only when you actually modified `packages/pythia-client/src/**`:

1. Do the SERVICE steps above, AND
2. Bump the CLIENT line to its own new version (its own SemVer, independent of the service):
   `packages/pythia-client/package.json`, a `## <ver> — YYYY-MM-DD` entry atop its
   `CHANGELOG.md`, and the `` `<ver>` on public npmjs `` status line + a `**v<ver>**`
   history paragraph in its `README.md`.
3. `npm run build && npm test` green, commit, tag the SERVICE version, push.
4. `publish.yml` sees the new client version is not yet on npm → **publishes it**.

> The client's version need not match the service's. Give the client whatever SemVer its
> change warrants (patch/minor/major by its OWN API impact), independent of the tag.

## Prerequisites

- **Org Actions permission (one-time, owner):** `AncientPantheon` org must allow Actions
  **"Read and write"** (Settings → Actions → General). Without it the ghcr push is denied.
- `NPM_PUBLISHER` secret must be set for `publish.yml`'s npm auth. `image.yml` uses the
  automatic `GITHUB_TOKEN`.

## Notes

- Do NOT bump the client "to keep it aligned" with the service — that's the exact
  inflation v3.0.0 removed. Bump it ONLY for a real client-source change.
- Consumers of the SDK should pin `^3.0.0` — the client baselined at 3.0.0 and moves on
  its own cadence thereafter.
- ghcr packages default to private; fine (the VPS builds from source; ghcr is for rollback).
