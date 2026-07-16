# connectors-tabs — Review

Round 1. Scope: `apps/pythia/public/{admin.html,admin.js}` (≤3 files → correctness + conventions
inline + behavioral browser pass). **Zero findings.**

- Correctness: `renderEntryTiles` renders disabled chains inert via the existing planned-note path;
  the scoped `wireChainSubtabs` toggles only the chain page's panels; all relocated element IDs and
  loaders unchanged.
- Conventions: reuses the pre-existing `.subtabs`/`.subtab`/`.subpanel` CSS and the tile idiom; badge
  text made data-driven (`t.badge`) without duplicating the renderer.
- Behavioral (browser, built server): Connectors lists **StoaChain** + **Arweave (coming soon**,
  inert); the StoaChain page shows a header row + three tabs (Observation Pool | Upload Pool | Routing
  Rules), default Observation, and clicking Routing Rules swaps panels correctly.

Clean pass, no fixes needed. Suite green (274 + 42).
