# admin-connectors-ia — Plan

> Executes `docs/work/admin-connectors-ia/design.md`. Surface: `apps/pythia/public/{admin.html,admin.js,styles.css}`
> (browser files, no unit-test harness — verify via `node --check`, full `npm test` staying green, and a
> behavioral browser pass at review; do NOT add a jsdom harness). Class vocabulary decision: KEEP the
> existing `.admin-tiles` / `.tile` / `.tile--planned` names (Mnemosyne also calls its lined rows
> "tiles" in a tilelist) — the lined-entry change is CSS-only restyling of those classes, and the new
> chain list reuses them. View naming fixed here: `data-view` values and `VIEW_LOADERS` keys are the
> full nested names — `connectors`, `connectors/stoachain`, `verifiers`, `update-deploy`.

## Wave 1
- [x] T1: Restructure the admin IA — nested router, 4-entry landing, chain list, chain page, unified
      Update & Deploy view — done when: (a) `TILES` in `admin.js` is exactly: `verifiers` (enabled),
      `connectors` (enabled, hash `#connectors`, ⛓️-style icon, blurb about chain connectors),
      `update-deploy` (NOW `enabled:true`, hash `#update-deploy`), `security` (still `enabled:false`,
      planned badge + inert note) — the `version` tile is REMOVED; (b) `routeFromHash()` parses the
      full hash after `#` (may contain one `/`), matches it against `VIEW_LOADERS`/`data-view` values
      exactly, and REDIRECTS legacy names by rewriting `location.hash`: `observation`→
      `connectors/stoachain`, `upload`→`connectors/stoachain`, `version`→`update-deploy`; unknown →
      landing; (c) `admin.html` gains `<section class="admin-view" data-view="connectors">` — the
      chain list, rendered by a new `renderChains()` from a `CHAINS` array in `admin.js`
      (`{id:'stoachain', icon, title:'StoaChain', blurb, hash:'#connectors/stoachain', enabled:true}`),
      reusing the `.admin-tiles`/`.tile` markup idiom, with a `.admin-back` returning to the landing;
      (d) `admin.html` gains `<section class="admin-view" data-view="connectors/stoachain">` — the
      chain page — into which the EXISTING Observation-Pool and Upload-Pool panel markup (hub form,
      hub status, txsender forms + list; all element IDs unchanged) is RELOCATED verbatim, headed by
      pool sub-headings, plus an empty `<div id="stoachain-rules">` placeholder (T2 fills it); its
      `.admin-back` returns to `#connectors` (back controls get a `data-back="#…"` attr and the
      handler navigates there; the plain landing views keep clearing the hash); (e) the old
      `data-view="observation"`, `data-view="upload"`, and `data-view="version"` sections no longer
      exist; (f) `admin.html`'s `data-view="update-deploy"` section (new) holds the RELOCATED
      version/network readout (`<div id="version-network">` + `loadVersionNetwork()` unchanged in
      admin.js) under a heading relabeled "Version & seed-pair health" with a `.panel-note` stating
      that `/healthz` reports only the two config seed nodes and can differ from the pool actually
      serving reads, plus a "Deploy controls land in the next round (topic: update-deploy)" note —
      no buttons, no backend calls; (g) `VIEW_LOADERS` maps `verifiers`→loadVerifiers,
      `connectors/stoachain`→ a fn firing BOTH `loadHubStatus()` and `loadTxSenders()`,
      `update-deploy`→loadVersionNetwork, `connectors`→ none/no-op; (h) deep-linking
      `/admin#connectors/stoachain` (ancient session) opens the chain page directly and Back walks
      chain page → chain list → landing. Checkable: `node --check apps/pythia/public/admin.js`
      passes; `grep -c 'data-view="observation"\|data-view="upload"\|data-view="version"'
      apps/pythia/public/admin.html` returns 0; `grep -c 'data-view="connectors"' → ≥1` and
      `'data-view="connectors/stoachain"' → 1`; full `npm test` stays green.
  - files: `apps/pythia/public/admin.html`, `apps/pythia/public/admin.js`

## Wave 2 (depends on Wave 1)
- [x] T2: Render the StoaChain routing rule-book — done when: `admin.js` defines a
      `STOACHAIN_RULES` array of `{title, body}` entries and a `renderStoachainRules()` that fills
      `#stoachain-rules` (created by T1) when the `connectors/stoachain` view opens (wired into that
      view's loader), rendering a headed panel ("How StoaChain routing works — verified against the
      code 2026-07-16") with one readable entry per rule. The rules MUST state, in plain English (the
      design's Approach section carries the authoritative list — copy its substance, not
      placeholder text): (1) reads/polls with the hub feed LIVE rotate the hub fleet as the primary
      leg with an Upload-Pool node as the fallback leg; (2) feed off / erroring / zero slots → both
      legs rotate the Upload Pool; (3) Upload Pool ALSO empty → 503 `pythia_no_read_node`;
      (4) failover is transport-failure-only — a node's HTTP error (4xx/5xx) is returned verbatim,
      never failed over; one retry, 10s per-attempt timeout, both legs failing → 502
      `pythia_pool_exhausted`; (5) a failed hub-feed poll keeps serving the LAST-GOOD slot list until
      the feed recovers or an admin reconfigures; (6) sends go ONLY to the Upload Pool, tried in the
      order they were added; empty/all-disabled pool → fail-closed 503 `pythia_no_tx_sender`; sends
      NEVER touch hub read nodes; (7) the two seeds (node1/node2.stoachain.com) are permanent — they
      cannot be disabled or removed, and they serve reads whenever the feed is off; (8) cadences: hub
      feed re-polled every 60s, seed-pair health every 15s; there is no node blacklist or circuit
      breaker — every request fails over live. Checkable: `node --check` passes; the strings
      `pythia_no_read_node`, `pythia_no_tx_sender`, `pythia_pool_exhausted`, and `60s` appear in
      admin.js's rules content; full `npm test` stays green.
  - files: `apps/pythia/public/admin.js`, `apps/pythia/public/admin.html`

- [x] T3: Restyle the landing + chain list to Mnemosyne-style lined entries — done when:
      `styles.css`'s `.admin-tiles` block becomes a single-column vertical LIST (each `.tile` a
      full-width row: icon left, title+blurb stacked right, subtle hover highlight/indent — no
      auto-fill grid, no card-lift), `.tile--planned` stays visibly muted with its badge, and the
      restyle keeps using the existing design tokens (`--panel`, `--line`, `--gold-dim`,
      `--ink-mute`); the chain list (same classes) inherits the look automatically; no other
      selector's behavior changes. Checkable: `grid-template-columns: repeat(auto-fill` no longer
      appears in the `.admin-tiles` rule; loading `/admin` shows stacked full-width rows; existing
      pages render unchanged. Depends on T1 only for visual verification (classes unchanged) —
      disjoint files from T2 → runs in parallel with it.
  - files: `apps/pythia/public/styles.css`
