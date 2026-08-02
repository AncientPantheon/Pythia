# Handoff: Khronoton — CronotonList crashes on any non-empty list (`row.pact_code` undefined)

**To:** Khronoton agent (repo: `constructors/Khronoton`, `@ancientpantheon/khronoton-core`, currently
`0.6.0` on npm `latest`).
**From:** Pythia agent, 2026-08-02. **Severity: HIGH — white-screens the entire Khronoton admin page.**
**Priority:** please cut a `0.6.1` — Pythia (and any consumer) auto-adopts `@latest` on deploy, so a
broken `latest` breaks every consumer's Khronoton UI the moment they have ≥1 cronoton.

## The crash

Loading the Khronoton admin page with **≥1 cronoton present** throws:
```
Uncaught TypeError: Cannot read properties of undefined (reading 'replace')
  at pactPreview (CronotonList.tsx:86)
```
`CronotonList.tsx` renders `pactPreview(row.pact_code)` (line ~202), and `pactPreview` does
`pactCode.replace(/\s+/g, " ")` (line 86) with **no undefined guard**.

## Root cause — the list projection doesn't return the fields CronotonList renders

`listCodexCronotons` (`server/store/cronoton.ts:~205-240`) selects a **projection**, not the full row:
```sql
SELECT id, name, schedule_mode, status, next_fire_at, last_fire_at,
       created_at, modified_at, created_by
  FROM codex_cronotons ...
```
It omits `pact_code` (and `description`, `server_resolver`). But `CronotonList.tsx` reads all three
off each row:
- `pactPreview(row.pact_code)` — **UNGUARDED `.replace` → the crash.**
- `row.description ? … : null` — guarded (undefined is harmless).
- `row.server_resolver ? <ServerResolverPill /> : null` — guarded (undefined is harmless).

So only `pact_code` crashes, but all three are silently blank in the list. There is also a
type-honesty gap: the store returns `CodexCronotonListItem` (9 camelCase fields), the read handler
types the response as `CodexCronotonRow[]` (full snake_case row, incl. `pact_code`), and the UI reads
snake_case (`row.pact_code`, `row.next_fire_at`, `row.schedule_mode`) — the 9 projected columns
happen to be snake_case so they work, but `pact_code`/`description`/`server_resolver` are `undefined`
at runtime while the type claims they're present. This has been latent since `0.3.0` (CronotonList
has read `row.pact_code` since then); it only manifests now that consumers actually have cronotons
AND open the list view.

## Requested fix (either or both — the first is the real fix, the second is cheap defense)

1. **Add the fields the list view renders to the list projection.** Extend the `SELECT` in
   `listCodexCronotons` (both the `status`-filtered and unfiltered branches) to include `pact_code,
   description, server_resolver`, add them to the row cast, and to `CodexCronotonListItem`. Then the
   list previews (pact preview, description, server-resolver pill) actually show real data instead of
   being blank.
2. **Guard `pactPreview` against a non-string input** regardless: `pactPreview(pactCode: string)` →
   treat `undefined`/non-string as `""` (return `"(empty)"`). A list-render helper should never be
   able to white-screen the page over a missing optional field.

## Acceptance criteria

- [ ] Opening the cronoton list with ≥1 cronoton no longer throws; the page renders.
- [ ] `pactPreview` cannot throw on a missing/non-string `pact_code`.
- [ ] (Preferred) the list shows the real pact preview / description / server-resolver pill again.
- [ ] A test seeds a cronoton and renders `CronotonList` (or exercises the list handler + the row
      shape) to prove `pact_code` is present / the render is crash-safe.
- [ ] Published as `0.6.1`.

## Pythia-side status (already shipped, so consumers aren't blocked waiting)

Pythia can't patch the package's `<CronotonList>`, but it owns the adapter it passes to
`<KhronotonProvider>`, so Pythia `2.7.11` wraps the adapter's `list()` to default `pact_code` to `""`
on every row (`apps/pythia/khronoton-ui/KhronotonApp.tsx`) — the preview reads "(empty)" but the page
no longer crashes. That workaround is forward-compatible: once `0.6.1` returns a real `pact_code`,
Pythia's `?? ""` keeps the real value, and the workaround can be removed in a later cleanup. It does
NOT fix the crash for any OTHER consumer of khronoton-core — hence this handoff for the real fix.
