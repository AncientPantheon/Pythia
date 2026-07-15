# card-admin — Review

Round 1. Scope: 3 files (`apps/pythia/public/{admin.html,admin.js,styles.css}`) — the ≤3-file tier,
so 2 lenses (correctness + conventions) inline. Browser DOM/CSS with no unit-test harness (per repo
convention); verification is `node --check` + full suite green + **behavioral** (real browser).

## Findings
**None.** Both lenses came back clean:
- **Correctness:** the gate handles `authState === null` (checking) and all four states; `renderTiles`
  renders enabled tiles as `<a href=hash>` and planned tiles as inert `<button>` → `showPlannedNote`;
  `routeFromHash` guards with `hasOwnProperty` and only opens known views, firing their `load*` on
  open; `loadVersionNetwork` throws on non-ok and renders a single error line on any failure. All
  `VIEW_LOADERS` targets exist.
- **Conventions:** matches the existing `createElement`/`className`/`textContent` idiom and reuses the
  `.dot`/`.txrow`/`.panel-note`/`.empty` vocabulary; CSS is a pure append reusing the existing design
  tokens (`--panel`, `--gold-dim`, `--maxw`), no selector collisions.

## Verification (post-build, before deploy)
- `node --check apps/pythia/public/admin.js` → OK; `<nav class="subtabs">` removed from admin.html.
- Full suite: `apps/pythia 248 passed (41 files)`, `pythia-client 42 passed (6 files)`; `npm run build` OK.
- **Behavioral (real browser, built server on :3011):**
  - Logged-out → the gate shows the "Sign in as an ancient admin" prompt (no console errors).
  - Ancient (mocked `/api/me`) → gate opens; **6 tiles render**: Verifiers, Observation Pool, Upload
    Pool, Version & Network (enabled `<a>`), Update & Deploy + Security (`tile--planned` `<button>`).
  - Router: navigating `#version` hides the landing and shows only the `version` view; the view read
    live `/healthz` and rendered **"Version: 1.7.0"** + both sources (primary/fallback) with reachability.

Rounds: 1. Zero findings; clean pass with behavioral verification. Ready to deploy.
