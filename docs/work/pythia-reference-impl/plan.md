# pythia-reference-impl — Plan

> Rebuild Pythia's admin to conform to `pantheonic-architecture/design/PANTHEONIC-DESIGN-ARCHITECTURE.md`
> v1.0 — it becomes the cited reference implementation. Surface: `apps/pythia/public/{admin.html,admin.js,styles.css}`
> (vanilla, no unit-test harness → verify via `node --check` + full `npm test` green + behavioral browser
> pass). Fixed class vocabulary (both tasks agree): `.admin-header` `.admin-header-left`
> `.admin-header-title` `.role-badge`(+`--ancient`) `.admin-layout` `.admin-sidebar` `.admin-nav-item`
> (+`--active`,`--planned`) `.admin-pane` `.admin-empty`. Keep existing section classes untouched.

## Wave 1
- [x] T1: Rebuild the admin shell — standardized header + sidebar + content pane + routing — done when
      `apps/pythia/public/{admin.html,admin.js}`: (a) the cramped `.topbar` becomes the **Pantheonic
      Header (admin variant)**: `.admin-header` with `.admin-header-left` = `← Pythia` ghost back
      (leftmost) + `.admin-header-title` ("Admin"), and the identity block `#authbox` on the right;
      (b) `renderAuthbox()` renders the identity block per the guideline — `Signed in as <b>name</b>`
      + a `.role-badge` (ancient → `.role-badge--ancient`) + `Log out`; role via `textContent`;
      (c) the `#admin-tiles` landing is REPLACED by a persistent `.admin-sidebar` (a `.admin-layout`
      grid = sidebar + `.admin-pane`), rendered from the existing `TILES` array as `.admin-nav-item`s
      (icon+label; `--planned` greyed+inert via `showPlannedNote`); (d) routing: `/admin` (no hash) →
      the `.admin-pane` shows `.admin-empty` ("Select a section from the left to begin"); `/admin#<id>`
      → that `.admin-view` renders in the pane and its sidebar item gets `--active`; nested
      `#connectors/stoachain` renders in the pane with the `connectors` sidebar item active; existing
      `LEGACY_HASHES` redirects kept; (e) move the `.admin-view` sections into `.admin-pane`, drop the
      top-level `← Dashboard` back buttons (the sidebar is the nav) but KEEP the stoachain
      `← Connectors` (`data-back="#connectors"`); (f) ALL existing loaders/wirers unchanged
      (`VIEW_LOADERS`, verifiers/hub/txsenders/rules/version/deploy, `wireChainSubtabs`,
      `wireDeployButton`, etc.) still fire on their view. Checkable: `node --check apps/pythia/public/admin.js`;
      `grep -c 'admin-sidebar\|admin-nav-item\|admin-empty\|admin-layout' admin.html` ≥4; `admin-tiles`
      landing div gone; full `npm test` green.
  - files: `apps/pythia/public/admin.html`, `apps/pythia/public/admin.js`

- [x] T2: The Pantheonic layout CSS — done when `apps/pythia/public/styles.css`: (a) adds the
      canonical accent token — `--accent: var(--gold); --accent-dim: var(--gold-dim);` at `:root`
      (keep `--gold` working); (b) `.admin-header` = a clean flex bar (back+title left, identity
      right, `justify-content: space-between`, aligned, bottom `--line` border) — fixes the cramped
      topbar; `.role-badge` = a small pill (`--line` border, `--ink-soft`), `.role-badge--ancient`
      uses `--accent`; (c) `.admin-layout` = a two-column grid (`grid-template-columns: 220px 1fr`,
      gap) capped by the existing `.shell`/`--maxw`; `.admin-sidebar` = a vertical menu, each
      `.admin-nav-item` a full-width row (icon+label, hover), `--active` = accent left-border + raised
      bg, `--planned` = muted + not-allowed; `.admin-pane` holds the section; `.admin-empty` = a
      centered muted prompt panel; (d) responsive: `@media (max-width: 820px)` the layout stacks
      (sidebar becomes a horizontal scrollable row of nav items above the pane); (e) no other selector
      regresses. Checkable: `grep -c '\.admin-layout\|\.admin-sidebar\|\.admin-nav-item\|\.admin-empty\|\.role-badge\|--accent' styles.css` ≥6; braces balanced; existing pages unchanged. Disjoint file
      from T1 → parallel.
  - files: `apps/pythia/public/styles.css`
