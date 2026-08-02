# khronoton-cronotonlist-crash-workaround — Design

Quick-scale hotfix (operator-reported: the Khronoton admin page white-screened after a v2.7.10
deploy). Post-hoc record.

## Problem

Opening the Khronoton admin page threw `Uncaught TypeError: Cannot read properties of undefined
(reading 'replace')` and rendered nothing. Traced to khronoton-core **0.6.0** (which Pythia's deploy
auto-adopted via `@latest` — Pythia pins `^0.4.2` but the deploy always bumps constructors to
latest): `CronotonList.tsx` renders `pactPreview(row.pact_code)`, and `pactPreview` does
`pactCode.replace(...)` with no undefined guard — but the cronoton LIST projection
(`listCodexCronotons`) never returns `pact_code`. So the moment the list has ≥1 cronoton, the page
crashes. It surfaced now because the operator had just created their first cronoton and opened the
list view. NOT caused by v2.7.10's own change (the Back button lives in the Builder branch, never
rendered on the list) — confirmed by the crash being in khronoton-core's `CronotonList`, on the list
view.

## Approach

Pythia can't patch the package's `<CronotonList>` component, but it owns the adapter it passes to
`<KhronotonProvider>`. Wrap `createFetchAdapter`'s `list()` to default `pact_code` to `""` on every
returned row (`apps/pythia/khronoton-ui/KhronotonApp.tsx`) — so `pactPreview("")` returns "(empty)"
instead of crashing. Forward-compatible: a fixed package that returns a real `pact_code` keeps it via
`r.pact_code ?? ""`. Deploy-model note: since the deploy auto-adopts `khronoton-core@latest`, pinning
package.json to an older version would NOT help (the deploy overrides the pin to `@latest`, and this
bug is latent all the way back to 0.3.0 anyway) — a workaround that runs WITH 0.6.0 is the only thing
that unblocks the next deploy. The real fix is a khronoton-core `0.6.1`, tracked in
`docs/HANDOFF-khronoton-cronotonlist-crash.md`.

## Acceptance criteria

- [x] The Khronoton admin page renders with ≥1 cronoton present (no `.replace` crash) — the adapter
      guarantees `pact_code` is a string on every list row.
- [x] The workaround is a no-op degradation once khronoton-core returns a real `pact_code` (via
      `?? ""`).
- [x] A precise khronoton-core handoff exists for the real fix
      (`docs/HANDOFF-khronoton-cronotonlist-crash.md`).
- [x] typecheck + island build + full suite green (islands have no automated test harness, per
      convention — verified via typecheck, `node --check`, and bundle grep).

## Out of scope

- The real khronoton-core fix (list projection returning `pact_code`/`description`/`server_resolver`,
  and guarding `pactPreview`) — handed off for `0.6.1`.
- Reconsidering whether Pythia should auto-adopt `khronoton-core@latest` blindly vs. pin to
  known-good — a broader deploy-policy question surfaced by this incident, noted but not changed here.
