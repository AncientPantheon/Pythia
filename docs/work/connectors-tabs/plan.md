# connectors-tabs — Plan

> Executes `docs/work/connectors-tabs/design.md` (honey run). Single coherent task — plan kept for
> resumability. Verification: `node --check` + full suite green + behavioral browser pass at review.

## Wave 1
- [x] T1: Arweave coming-soon entry + tabbed expand-in-place chain page — done when: (a) `CHAINS` in
      `apps/pythia/public/admin.js` gains `{id:'arweave', icon:'🧵-style', title:'Arweave',
      blurb, enabled:false}` and `renderChains()` renders disabled chains with a `.tile-badge`
      reading "coming soon", inert via the existing planned-note pattern (no view, no backend);
      (b) the `connectors/stoachain` view in `admin.html` gains a non-clickable chain **header row**
      (`.tile` look: ⛓ icon + "StoaChain" title) above a `.subtabs` bar with three `.subtab` buttons
      — Observation Pool | Upload Pool | Routing Rules — toggling three `[data-subpanel]` groups
      (hub form+status | txsender forms+list | #stoachain-rules), default Observation Pool visible;
      (c) a scoped tab-switcher in admin.js wires them (the old `wireSubtabs` pattern, reintroduced
      scoped to the chain page); (d) all existing element IDs unchanged; every pool action + the
      rule-book render still work inside their tabs; (e) the `.admin-back` (→ `#connectors`) remains.
      Checkable: `node --check apps/pythia/public/admin.js`; `grep -c 'coming soon'` ≥1 in admin.js;
      `grep -c 'data-subpanel'` ≥3 in admin.html; full `npm test` green.
  - files: `apps/pythia/public/admin.html`, `apps/pythia/public/admin.js`
