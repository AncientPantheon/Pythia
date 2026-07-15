# container-ci — Plan

> Executes `docs/work/container-ci/design.md`. Target unified version: **1.7.0** (client jumps from
> 1.1.0; service/root/version.ts move 1.6.0→1.7.0). Do NOT push a tag/release — owner's call.
> Note: the version-consistency test lives in the `apps/pythia` workspace (not a root `tests/` dir)
> because CI runs `npm test` → `npm run test --workspaces`; a root-level test would never run.

## Wave 1
- [x] T1: Unify the version to `1.7.0` across all four version files — done when: `version` is
      `"1.7.0"` in `package.json`, `packages/pythia-client/package.json`, and
      `apps/pythia/package.json`, and `PYTHIA_VERSION === "1.7.0"` in `apps/pythia/src/version.ts`;
      `grep -R '"version"' package.json packages/pythia-client/package.json apps/pythia/package.json`
      shows `1.7.0` for all three and no file still reads `1.1.0`/`1.6.0`/`0.0.0`.
  - files: `package.json`, `packages/pythia-client/package.json`, `apps/pythia/package.json`, `apps/pythia/src/version.ts`

- [x] T2: Create the root `CHANGELOG.md` (repo/service changelog, Mnemosyne bracket format) — done
      when: `CHANGELOG.md` exists at repo root, its first `## ` heading is `## [1.7.0] — 2026-07-15`,
      and that entry lists this topic's changes (version unify, ghcr image publish, versioning gate).
      The regex `^##\s*\[(\d+\.\d+\.\d+)\]` captures `1.7.0` on the first match.
  - files: `CHANGELOG.md`

- [x] T3: Bump the client's own CHANGELOG + README to `1.7.0` (what `publish.yml`'s client-parity
      greps read) — done when: `packages/pythia-client/CHANGELOG.md` first `## ` heading is
      `## 1.7.0 — 2026-07-15` (client format, no brackets); `packages/pythia-client/README.md` `##
      Status` block contains a line matching `` `1.7.0` on public npmjs `` and its version history
      contains a `**v1.7.0**` paragraph. Note in the CHANGELOG entry that 1.2.0–1.6.0 were skipped to
      align the client with the service version line.
  - files: `packages/pythia-client/CHANGELOG.md`, `packages/pythia-client/README.md`

- [x] T4: Add the ghcr image-publish workflow — done when: `.github/workflows/image.yml` triggers on
      `push: tags: ["v*"]` + `workflow_dispatch`, has `permissions: { contents: read, packages: write }`,
      and runs, in order, `actions/checkout@v4` → `docker/setup-buildx-action@v3` →
      `docker/login-action@v3` (registry `ghcr.io`, username `${{ github.actor }}`, password
      `${{ secrets.GITHUB_TOKEN }}`) → `docker/metadata-action@v5` (images
      `ghcr.io/ancientpantheon/pythia`, tags `type=semver,pattern={{version}}` + `type=raw,value=latest`)
      → `docker/build-push-action@v6` (context `.`, `push: true`, tags/labels from metadata,
      `cache-from: type=gha`, `cache-to: type=gha,mode=max`). buildx step precedes build-push.
  - files: `.github/workflows/image.yml`

- [x] T5: Rework `publish.yml` so the tag gate is the unified version (root `package.json`), not the
      client version — done when: the "Verify tag matches …" step reads
      `node -p "require('./package.json').version"` as `UNIFIED_VERSION` and fails if
      `TAG_VERSION != UNIFIED_VERSION`; the existing client README/CHANGELOG parity greps and the
      idempotent `npm publish --workspace=@ancientpantheon/pythia-client … --provenance` step remain;
      the "Typecheck + Build + Test" step is unchanged (it runs the T6 test, enforcing four-file
      agreement during publish). A comment documents that one `v*` tag now drives both this workflow
      and `image.yml`.
  - files: `.github/workflows/publish.yml`

- [x] T7: Add the release procedure doc — done when: `docs/RELEASING.md` documents that root
      `package.json` version is the single source of truth mirrored into the client package, service
      package, and `version.ts`; that every bump adds a matching top `## [x.y.z]` entry to root
      `CHANGELOG.md` (and a `## x.y.z` entry + README bumps to the client) in the same commit; that
      one `v*` tag fires both `publish.yml` (npm) and `image.yml` (ghcr); and it records the org
      prerequisite (Actions "Read and write" for the ghcr push) and the local check sequence
      (`npm run build` + `npm test` before tagging).
  - files: `docs/RELEASING.md`

## Wave 2 (depends on Wave 1)
- [x] T6: Add the version-consistency test — done when: `apps/pythia/src/versionConsistency.test.ts`
      resolves the repo root from `import.meta.url`, reads the `version` field of root `package.json`,
      `packages/pythia-client/package.json`, `apps/pythia/package.json`, imports `PYTHIA_VERSION` from
      `./version`, and extracts the newest `## [x.y.z]` entry from root `CHANGELOG.md`; it asserts all
      five are equal and match `/^\d+\.\d+\.\d+$/`. Running `npm test -w @ancientpantheon/pythia`
      passes with everything at 1.7.0; hand-editing any one of the five to a different value makes it
      fail. Depends on T1 (version bumps) + T2 (root CHANGELOG). (Placed in the `apps/pythia`
      workspace so `npm test` picks it up.)
  - files: `apps/pythia/src/versionConsistency.test.ts`

- [x] T9: Rewrite the stale cross-workspace e2e smoke test to the current service API — done when:
      `packages/pythia-client/tests/e2e.integration.test.ts` wires the service the modern way (drops
      the obsolete `sources` prop; supplies the current `SendDeps`/`ReadDeps` incl. a configured
      tx-sender / dial so the send path succeeds), mirroring how `apps/pythia/src/routes/send.test.ts`,
      `read.test.ts`, and `poll.test.ts` construct their deps today; `npx tsc --noEmit` passes in
      `packages/pythia-client`, `npm test -w @ancientpantheon/pythia-client` passes, and the full
      `npm test` (all workspaces) is green. Pre-existing rot (last touched at v1.1.0, broke when the
      service moved to the Upload-Pool/tx-sender architecture); surfaced during this build, owner
      chose rewrite. Traces to the design's "full test suite stays green throughout" criterion.
  - files: `packages/pythia-client/tests/e2e.integration.test.ts`

- [x] T8: Register the container in Claudstermind's managed-package list — done when: the
      `ghcr.io/ancientpantheon/pythia` container appears as a managed/observed package in the
      Claudstermind dashboard config, alongside the existing `@ancientpantheon/pythia-client` npm
      entry. First locate Claudstermind's package-registry config (it lives outside the Pythia repo —
      likely under the workspace `.wasp/` config or a dashboard config file); if the format/location
      isn't a clear single-file edit, surface the exact file + proposed entry to the owner rather than
      guessing. Depends on T4 (the image coordinates the entry references).
  - files: (external to this repo — determined by discovery; not a Pythia-repo path)
