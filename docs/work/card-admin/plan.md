# card-admin — Plan

> Executes `docs/work/card-admin/design.md`. Surface: `apps/pythia/public/{admin.html,admin.js,styles.css}`.
> These are static browser files (served as-is, not compiled), and `public/*.js` has **no** unit-test
> harness in this repo — consistent with that, verification is `node --check` (JS validity) + the full
> `npm test` suite staying green (no `src/` change) + behavioral checks at review/deploy. Do NOT add a
> jsdom/vitest harness for `public/` — out of scope. Shared class vocabulary (fixed here so all tasks
> agree): `.admin-tiles` (grid), `.tile` / `.tile--planned`, `.admin-view` (function-view container),
> `.admin-back` (back-to-dashboard control).

## Wave 1
- [x] T1: Restructure `/admin` into an AdminGate + tile-landing + hash-router shell — done when:
      (a) `admin.html` replaces the `<nav class="subtabs">` strip with an `<div id="admin-tiles"
      class="admin-tiles">` landing container, keeps the three existing panels (verifiers /
      observation / upload) but as hidden `.admin-view` containers each with a `.admin-back`
      "← Dashboard" control; (b) `admin.js` defines a static `TILES` array (`{id, icon, title, blurb,
      hash, enabled}`) and renders the landing grid from it; (c) `applyGate()` is refactored into a
      gate owning FOUR states — a brief "checking…" state before `/api/me` resolves, a logged-out
      login prompt, a "requires the ancient role" notice for authenticated non-ancients, and the tile
      landing for ancients; (d) a hash-router shows the landing when `location.hash` is empty and the
      matching `.admin-view` (hiding the landing) for `#verifiers` / `#observation` / `#upload`, with
      the back control clearing the hash to return to the landing; loading `/admin#verifiers` directly
      opens that view and browser Back returns to the landing; (e) the existing verifier / hub /
      tx-sender `load*`/`render*`/`wire*` functions are reused unchanged and still fire when their
      view opens (add/enable/remove verifier; hub save+refresh; tx-sender add/enable/remove/bulk all
      still work); (f) two disabled tiles — `update-deploy` and `security` — render with a "planned"
      badge (`.tile--planned`) and are inert (clicking shows a short "coming in a later round" note,
      never a broken view or a backend call). Checkable: `node --check apps/pythia/public/admin.js`
      passes; the old `<nav class="subtabs">` is gone from `admin.html`; `npm test` stays green.
  - files: `apps/pythia/public/admin.html`, `apps/pythia/public/admin.js`

## Wave 2 (depends on Wave 1)
- [x] T2: Add the Version & Network tile + view — done when: `admin.js`'s `TILES` array includes a
      `version` tile (enabled) and `admin.html` has a `#version` `.admin-view`; opening it (tile click
      or `/admin#version`) calls a `loadVersionNetwork()` that `fetch`es `GET /healthz` and renders the
      live `version` string plus one row per entry in `sources` (`{id, url, role, reachable}`) showing
      reachability (reuse the existing `.dot` `data-color` green/red idiom); a fetch/parse failure
      renders a single error line, not a broken view. Checkable: `node --check apps/pythia/public/admin.js`
      passes; with the local server running, `/admin#version` shows the version from `/healthz`.
      Depends on T1 (tile array + router + view scaffold). Serial with any other admin.html/admin.js task.
  - files: `apps/pythia/public/admin.html`, `apps/pythia/public/admin.js`

- [x] T3: Add tile + view CSS — done when: `styles.css` styles `.admin-tiles` as a responsive wrapping
      grid of `.tile` cards (icon + title + blurb, hover affordance), `.tile--planned` as a visibly
      disabled/muted card, and `.admin-view` + `.admin-back` consistent with the existing panel /
      starfield / `--maxw` design tokens already in the file; the landing grid wraps at narrow widths
      and existing admin + landing styles are unchanged (no selector collisions). Checkable: the new
      selectors exist in `styles.css`; loading `/admin` shows a card grid, not a bare list; existing
      pages render unchanged. Depends on T1 (uses the class vocabulary it introduces). Disjoint files
      from T2 → runs in parallel with it.
  - files: `apps/pythia/public/styles.css`
