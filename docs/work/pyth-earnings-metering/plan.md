# pyth-earnings-metering — Plan

Sprint = 7 checkpoints, **one commit each**, then a single push + deploy + version
bump at the end. Test command: `npm test -w @ancientpantheon/pythia`.

## CP1 — Pondus formula + fleet-wide Pyth ledger store ✅
- [x] T1: `apps/pythia/src/pyth/pondus.ts` — `pondus({classBase,gasUsed,responseBytes})` =
      `classBase + √gasUsed/2 + responseBytes/4096` (√ per-request; 0 when gas/bytes 0),
      `CLASS_BASE = {read:10, poll:5}`, `round3(x)`. Done when: unit tests cover
      read/poll/gas/bytes cases + the per-request-√ property against handoff numbers.
  - files: `apps/pythia/src/pyth/pondus.ts`, `apps/pythia/src/pyth/pondus.test.ts`
- [x] T2: `apps/pythia/src/pyth/ledger.ts` — a keyless `PythLedger` (model on
      `stats/store.ts`): per-UTC-day counters {petitions, pondus, transactions,
      gasReserved, failedTransactions, wastedGasReserved}; `recordRead(pondus)`,
      `recordSend(accepted, gasLimit)`, `total()` (summed, pondus round3), `daily()`,
      `nuke()`, atomic snapshot persist + load. Done when: tests cover record/total/
      daily/nuke + persist-reload round-trip.
  - files: `apps/pythia/src/pyth/ledger.ts`, `apps/pythia/src/pyth/ledger.test.ts`

## CP2 — Meter reads/polls + sends into the ledger ✅
- [x] T3: wire metering — reads/polls compute pondus from the node response (gas +
      bytes) → `recordRead`; sends record `recordSend(accepted, ΣgasLimit)` where
      accepted = relay ok, gasLimit parsed from each caller cmd's `meta.gasLimit`.
      Keyless (reads gas/bytes/gasLimit only). Done when: tests drive a read and a
      send (accepted + rejected) and assert the ledger deltas; keylessScanner passes.
  - files: `apps/pythia/src/pyth/meter.ts`, `apps/pythia/src/pyth/meter.test.ts`,
    `apps/pythia/src/routes/relay.ts`, `apps/pythia/src/routes/send.ts`, `apps/pythia/src/index.ts`

## CP3 — Activity shows Petitions/Pondus + Transactions/Gas ✅
- [x] T4: expose the ledger totals + daily via an endpoint (`GET /pyth` or extend
      `/stats`); rework the StoaChain Activity view — headline Petitions · Pondus +
      Transactions · Gas relayed; remove the Errors card and the Poll metric. Done
      when: the endpoint returns the six counters and Activity renders them (browser-
      verified), no Errors/Poll.
  - files: `apps/pythia/src/routes/pyth.ts`, `apps/pythia/src/routes/pyth.test.ts`,
    `apps/pythia/public/index.html`, `apps/pythia/public/app.js`, `apps/pythia/public/styles.css`

## CP4 — "StoaChain Earnings" admin tab ✅
- [x] T5: ancient-gated admin section: `POST /admin/pyth/nuke` (reset ledger,
      server-enforced ancient) + a report-to-hub on/off setting (`GET/POST
      /admin/pyth/report`), persisted; admin UI tab (nuke button + toggle). Done when:
      non-ancient is rejected server-side; nuke zeroes the ledger; toggle persists.
  - files: `apps/pythia/src/admin/routes.ts`, `apps/pythia/src/admin/settingsStore.ts`,
    `apps/pythia/src/admin/*.test.ts`, `apps/pythia/public/admin.html`, `apps/pythia/public/admin.js`

## CP5 — Self-polling tx-outcome tracker (execution level)
- [ ] T6: after a relay-accepted send, capture requestKey(s) + gasLimit; a background
      poller polls chainweb until mined (or times out), then records execution
      success/fail + actual gas, upgrading the tx metrics. Keyless (poll = read). Done
      when: tests simulate poll→success and poll→fail and assert the ledger reflects
      execution outcome + actual gas; unmined-timeout handled.
  - files: `apps/pythia/src/pyth/txTracker.ts`, `apps/pythia/src/pyth/txTracker.test.ts`,
    `apps/pythia/src/routes/send.ts`, `apps/pythia/src/index.ts`

## CP6 — Per-slot usage reporter (§4.3, money path)
- [ ] T7: `stats/slotUsage.ts` windowed per-slot meter (keyed/anon/ok + keyedPondus);
      `hub/serviceClient.ts` gains `postUsage(report)`; `stats/usageReporter.ts` ~60s
      timer drains + reports signed non-overlapping windows, honoring idempotency +
      the report toggle. Done when: tests cover the window drain/reset, the report
      shape (incl. keyedPondus + pondusVersion), and that the toggle-off skips POST.
  - files: `apps/pythia/src/stats/slotUsage.ts`, `apps/pythia/src/stats/usageReporter.ts`,
    `apps/pythia/src/hub/serviceClient.ts`, `apps/pythia/src/stats/*.test.ts`, `apps/pythia/src/index.ts`

## CP7 — Release 1.8.0
- [ ] T8: bump 1.7.0 → 1.8.0 in the four version files (versionConsistency test),
      CHANGELOG entry. Done when: `versionConsistency.test.ts` green, full suite green,
      build clean. THEN: push + blue-green deploy + live verify.
  - files: the four version files, `CHANGELOG.md`

*Each CP is its own commit; no push/deploy until CP7. Keep this file's checkboxes current.*
