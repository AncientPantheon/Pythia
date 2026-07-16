# admin-connectors-ia — Review

Round 1. Scope: 3 files (`apps/pythia/public/{admin.html,admin.js,styles.css}`) — ≤3-file tier,
2 lenses (correctness + conventions) inline + full behavioral browser pass.

## Findings
**None.** Correctness: nested router exact-matches `VIEW_LOADERS` keys, legacy hashes redirect by
rewriting `location.hash` (so history/bookmarks converge on canonical routes), back-targets via
`data-back` walk one level up, rule-book render is idempotent (container cleared per open), all
relocated section IDs unchanged so the untouched load/render/wire functions keep working.
Conventions: same createElement/textContent idiom, `renderEntryTiles` extracted instead of
duplicating the tile renderer, CSS edit confined to the tile block reusing existing tokens.

## Verification
- `node --check` OK; legacy `data-view` sections 0; auto-fill grid gone; full suite
  `248 passed` + `42 passed`; `npm run build` OK.
- **Behavioral (browser, built server on :3012, ancient session mocked):**
  - Landing = exactly 4 **lined entries** (computed style `flex/column`): Verifiers · Blockchain
    Connectors · Update & Deploy (enabled) · Security (planned, muted + PLANNED pill). Screenshot
    matches the Mnemosyne tilelist look.
  - `#connectors/stoachain` opens the chain page; the rule-book renders with heading "How StoaChain
    routing works — verified against the code 2026-07-16" and **8 rules** (read rotation, feed down,
    both pools empty, transport-only failover, last-good slots, sends, seed permanence, cadences).
  - Legacy `#observation` → redirected to `#connectors/stoachain` (hash rewritten).
  - `#update-deploy` shows `Version: 1.7.0`, the *seed-pair health* label, the healthz-only-reports-
    the-seed-pair note, and the deploy-controls-next-round note.
  - (Preview artifact, not a bug: the tx-sender/hub lists render empty because `/admin/*` data
    endpoints are server-gated and the preview has no real session; those render functions are
    byte-unchanged from production.)

Rounds: 1. Zero findings; clean pass with behavioral verification. Ready to deploy.
