# connectors-tabs — Design

> Honey-run topic (A of 2). Extends admin-connectors-ia: Arweave coming-soon entry + expand-in-place
> chain page with tabbed groups.

## Problem
The Blockchain Connectors list shows only StoaChain, so the multi-chain intent isn't visible. The
StoaChain page stacks Observation Pool, Upload Pool, and the routing rule-book vertically — the owner
wants clicking a chain to feel like the entry EXPANDING in place (other entries gone), with the
chain's content grouped into tabs and a back control to the list.

## Acceptance criteria
- [ ] The Connectors list shows **StoaChain** and **Arweave**; Arweave is inert with a **"coming
      soon"** badge (clicking it never opens a view or calls a backend).
- [ ] Clicking StoaChain opens the chain page: the list's other entries are no longer visible, a
      chain **header row** (icon + title, matching the list-entry look) tops the page, and the
      content is grouped into **three tabs: Observation Pool | Upload Pool | Routing Rules** — one
      group visible at a time, default Observation Pool.
- [ ] Every existing pool action still works inside its tab (hub save/refresh; tx-sender
      add/enable/remove/bulk; seeds badged); the rule-book renders in its tab.
- [ ] A back control returns to the chain list; deep link `/admin#connectors/stoachain` still opens
      the chain page (tabs at default).
- [ ] `node --check` passes; full suite green.

## Out of scope
- Any real Arweave connector functionality.
- Persisting the selected tab in the hash.

## Decisions
Autonomous run confirmed 2026-07-16.
- Tab UI reuses the existing `.subtabs`/`.subtab` CSS still present in styles.css (the markup pattern
  removed in topic card-admin returns, scoped to the chain page) — no new tab CSS.
- Arweave's badge reuses `.tile-badge` ("coming soon"); inert via the existing planned-note pattern.
- Chain header row reuses the `.tile` look (non-clickable div variant).
- Default tab: Observation Pool. Tab choice not persisted in the hash (out of scope above).
