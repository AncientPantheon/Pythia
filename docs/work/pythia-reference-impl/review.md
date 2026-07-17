# pythia-reference-impl — Review

Round 1. Scope: `apps/pythia/public/{admin.html,admin.js,styles.css}` (≤3 files → correctness +
conventions inline + a full behavioral browser pass). **Zero findings.**

- **Correctness:** the router shows the empty prompt on bare `/admin`, the matching `.admin-view` in
  the pane on `#section`, and marks the top-level nav item active for nested `#connectors/stoachain`
  (`name.split('/')[0]`); legacy hashes still redirect; every section's existing load/render/wire
  function is reused unchanged; role promotion (`ancient` first) + `textContent` safety intact.
- **Conventions:** reuses the existing token/panel/tile idiom; `--accent` added as an alias of
  `--gold` (contract name without churn); CSS purely additive, braces balanced.

## Behavioral verification (browser, built server, ancient session mocked)
- Bare `/admin` → sidebar (4 items: Verifiers · Blockchain Connectors · Update & Deploy · Security
  [planned, greyed]) + the pane shows **"Select a section from the left to begin."**
- Two-column grid lays out: **sidebar 220px + pane 929px** (`display:grid`, capped by `.shell`/`--maxw`).
- `#verifiers` → the Verifiers section renders in the pane, its nav item `--active`, empty prompt hidden.
- `#connectors/stoachain` → the chain page renders in the pane with the **Blockchain Connectors** nav
  item active and its three sub-tabs (Observation Pool | Upload Pool | Routing Rules) present.
- Identity block: `Signed in as preview · [ancient]` with the badge **accented** (role promoted from
  `['observer','ancient']`).

## Conformance to the standard (design/ v1.0)
Width (1536, one `.shell`), token contract (`--accent` present), Pantheonic Header (back-left,
one identity block, role badge), sidebar + content-pane admin (unselected prompt → section detail →
nested), 4-state gate — all met. This is the cited reference implementation.

Round 1, clean, behaviorally verified. `npm test` → `274 passed` + `42 passed`; `npm run build` OK.
