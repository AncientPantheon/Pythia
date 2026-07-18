# pyth-usage-reporter — Plan

Sprint = 4 checkpoints, one commit each, then push + deploy + v1.9.0 at the end.
Test command: `npm test -w @ancientpantheon/pythia`.

## CP1 — Served-slot plumbing (dial onServed + NodePool operator lookup) ✅
- [x] T1: `dial/dial.ts` — add optional `onServed?(node)` to `DialNodesDeps` +
      `DialDeps`, fired with the node whose response arrived; no return-type change.
      `NodePool` retains each hub slot's `operator` + exposes `operatorForSlot(id)`
      (null for non-hub ids). Read + poll handlers pass `onServed` to stash the
      served slot id on the context (`c.set("servedSlotId", …)`). Done when: dial
      tests assert onServed fires with the serving node (and not on the skipped one);
      operatorForSlot returns the operator for a hub slot, null for an upload node.
  - files: `apps/pythia/src/dial/dial.ts`, `apps/pythia/src/dial/dial.test.ts`,
    `apps/pythia/src/pool/nodePool.ts`, `apps/pythia/src/pool/nodePool.test.ts`,
    `apps/pythia/src/routes/read.ts`, `apps/pythia/src/routes/poll.ts`

## CP2 — Per-slot windowed meter (slotUsage) ✅
- [x] T2: `stats/slotUsage.ts` — `SlotUsageMeter`: record(slotId, operator, keyed,
      ok, pondus) for hub-slot READS only; `drain()` → `{period:{from,to}, slots:[…]}`
      + reset; a middleware/hook records from the context's servedSlotId +
      operatorForSlot + the read's pondus (keyed → keyedPondus). Done when: tests
      cover keyed/anon/ok/keyedPondus accumulation, the drain-and-reset, and that
      non-hub (null operator) reads are ignored.
  - files: `apps/pythia/src/stats/slotUsage.ts`, `apps/pythia/src/stats/slotUsage.test.ts`,
    `apps/pythia/src/pyth/meter.ts` (or a sibling), `apps/pythia/src/index.ts`

## CP3 — HMAC reporter (postUsage + usageReporter) ✅
- [x] T3: `hub/serviceClient.ts` gains `postUsage(report)` (signed §2.1 envelope →
      `POST /api/pythia/usage/`, echo slot id + keyedPondus + pondusVersion:1);
      `stats/usageReporter.ts` — a ~60s timer that drains + posts a contiguous
      non-overlapping window, SKIPS when the report toggle is off, retries a failed
      window with identical counts, skips empty windows. Done when: tests cover the
      report shape (incl. keyedPondus/pondusVersion), toggle-off skips the POST, and
      a failed post re-sends the same window unchanged.
  - files: `apps/pythia/src/hub/serviceClient.ts`, `apps/pythia/src/hub/serviceClient.test.ts`,
    `apps/pythia/src/stats/usageReporter.ts`, `apps/pythia/src/stats/usageReporter.test.ts`,
    `apps/pythia/src/index.ts`, `apps/pythia/src/server.ts`

## CP4 — Release 1.9.0
- [ ] T4: bump 1.8.0 → 1.9.0 (four version files + CHANGELOG, version gate green),
      full suite + build green, live-hub validation of one real report, then push +
      blue-green deploy + verify.
  - files: the four version files, `CHANGELOG.md`

*Each CP its own commit; no push/deploy until CP4. Keep the checkboxes current.*
