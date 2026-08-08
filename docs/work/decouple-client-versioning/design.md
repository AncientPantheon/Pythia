# Decouple the pythia-client version from the service — Design

## Problem
Every service (website/gateway) release bumps `@ancientpantheon/pythia-client` in lockstep and
republishes it to npm — even when the package's source is unchanged. Of the recent ~15 releases only ONE
(v2.7.31, the `pondus()` export) was a real client change; the rest are "version alignment" republishes
of an identical package. This is npm version inflation and conflates two independent lifecycles: the
**service** (private image) and the **client SDK** (public npm package consumed by OuronetUI / Mnemosyne
/ Explorer / Hub). The lockstep is forced by `versionConsistency.test.ts` (all four files must equal the
tag) + `publish.yml` (fires on every `v*` tag, gates on tag == client version).

## Approach
Split into two independent version lines, both starting at **3.0.0** as the clean baseline for the new
rule; thereafter the client "stays behind" (frozen) until its source actually changes.

- **SERVICE version** = the tag `vX.Y.Z` = `package.json` (root) = `apps/pythia/package.json` =
  `apps/pythia/src/version.ts` = the top `## [X.Y.Z]` entry in the root `CHANGELOG.md`. These stay in
  lockstep — they are all the one service. The tag is the service version.
- **CLIENT version** = `packages/pythia-client/package.json` = its `CHANGELOG.md` top `## X.Y.Z` = its
  README `` `X.Y.Z` on public npmjs `` status line. **Independent** — bumped ONLY when the client's own
  source/API/behavior changes. Not required to equal the service.

Mechanics:
1. **`versionConsistency.test.ts`** — rewrite: assert the SERVICE quartet agrees; assert the CLIENT trio
   (pkg + its changelog + its README) is internally consistent; drop the cross-assertion that client ==
   service.
2. **`publish.yml`** — the tag-vs-version check stays `tag == root` (root IS the service version). The
   client README/CHANGELOG parity greps and the `npm publish`/`npm view` skip check switch from
   `TAG_VERSION` to the **client's own** version (read from its package.json). Result: on a service-only
   release the client version is unchanged, its docs already match, and `npm view` finds it already
   published → the publish step **skips** (idempotent). On a real client release its version is bumped +
   docs updated → it publishes.
3. **`image.yml`** — no change. It checks `tag == root` (service) and runs the (relaxed) gate via
   `npm test`; both still hold.
4. **Docs** — document the two-line rule (in-repo release notes / the test's doc comment).
5. **This release** — service → 3.0.0 (root, app, version.ts, root CHANGELOG) AND client → 3.0.0 (pkg,
   its changelog, README) as the aligned baseline. From the NEXT service release on, the client stays at
   3.0.0 until modified.

### Alternatives considered
- *Separate `client-vX.Y.Z` tag stream* — rejected as heavier; the idempotent-publish-at-client-version
  approach on the existing `v*` tag achieves "publish only when changed" with one tag stream.
- *Keep the client at 2.7.31 (its true last change) instead of 3.0.0* — rejected per the operator's
  explicit call to baseline both at 3.0.0.

## Acceptance criteria
- [ ] `versionConsistency.test.ts` passes with service = 3.0.0 and client = 3.0.0, AND would still pass
      with a DIVERGED pair (e.g. service 3.0.1, client 3.0.0) — proven by a unit assertion that the
      client is checked only for internal consistency, not against the service.
- [ ] `publish.yml` reads the client's own version for its doc-parity greps and its publish/skip check
      (not the tag), so a service-only release skips the client publish while a client bump publishes it.
- [ ] `image.yml` unchanged and still correct (tag == service).
- [ ] Service files (root pkg, app pkg, version.ts, root CHANGELOG) = 3.0.0; client files (pkg, changelog,
      README) = 3.0.0; full `npm test` + typecheck green.
- [ ] The two-line rule is documented.

## Out of scope
- Changing the client's SemVer range guidance for consumers (they should move to `^3.0.0`).
- Any client source change (this release makes none to the client).
