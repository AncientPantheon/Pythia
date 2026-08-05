# Pyth live pulse + per-key transaction attribution — Plan

Test command: `npm test -w @ancientpantheon/pythia` (vitest). Frontend files
(`public/app.js`, `public/styles.css`) have no automated harness — verify via `node --check` +
id/selector cross-match + manual review (established convention).

## Wave 1
- [x] T1: Ledger — per-consumer send attribution + persistence.
  - Add `ConsumerTx { transactions; failedTransactions; gasReserved; wastedGasReserved }` and a private
    `byConsumer: Map<string, ConsumerTx>`. Extend `recordSend(accepted, gasLimit, count=1, consumer?)`:
    aggregate counters unchanged; when `consumer` is a non-empty string, also bump `byConsumer[consumer]`
    (zero-init if absent) — `transactions`+`gasReserved` on accept, `failedTransactions`+`wastedGasReserved`
    on reject, by `count`. Add `byConsumer(): Record<string, ConsumerTx>` (plain-object copy). Persist:
    add `byConsumer` to `LedgerSnapshot` + `snapshot()`; hydrate in `applySnapshot` (default `{}`, validate
    each numeric field, ignore malformed); clear the map in `nuke()`.
  - done when: `npm test -w @ancientpantheon/pythia src/pyth/ledger.test.ts` passes with new tests —
    (a) `recordSend(true, g, n, "ouronetui")` bumps BOTH aggregate `transactions` and
    `byConsumer()["ouronetui"].transactions` by n and gas by g; (b) `recordSend(false, g, n, "x")` bumps
    `failedTransactions`/`wastedGasReserved` per-consumer; (c) `recordSend(true, g)` with no consumer leaves
    `byConsumer()` empty; (d) a snapshot round-trip (persist → new PythLedger on same file) preserves
    `byConsumer`; (e) `nuke()` empties `byConsumer()`; (f) loading a legacy snapshot with no `byConsumer`
    key yields `{}` (no throw).
  - files: `apps/pythia/src/pyth/ledger.ts`, `apps/pythia/src/pyth/ledger.test.ts`

## Wave 2 (depends on Wave 1)
- [x] T2: txTracker — thread consumer through pending → record per-consumer on resolve.
  - Add `consumer?: string` to `PendingTx` and to the internal pending-map value; on mine call
    `ledger.recordSend(o.success, o.gas, 1, consumer)`; on timeout call
    `ledger.recordSend(false, p.gasLimit, 1, consumer)`.
  - done when: `npm test -w @ancientpantheon/pythia src/pyth/txTracker.test.ts` passes with new tests — a
    tracked entry `{requestKey, gasLimit, consumer:"c"}` that mines records `byConsumer()["c"].transactions`
    == 1; one that times out records `byConsumer()["c"].failedTransactions` == 1; an entry with no consumer
    records aggregate only (`byConsumer()` empty). Existing tracker tests still pass.
  - files: `apps/pythia/src/pyth/txTracker.ts`, `apps/pythia/src/pyth/txTracker.test.ts`
- [x] T3: meteredRuntime — attribute Pythia's own fires to `"pythia-self"`.
  - Add `export const PYTHIA_SELF_CONSUMER = "pythia-self";` and pass it as the 4th `recordSend` arg on
    both the accept (`recordSend(true, gas, 1, PYTHIA_SELF_CONSUMER)`) and throw
    (`recordSend(false, gas, 1, PYTHIA_SELF_CONSUMER)`) branches.
  - done when: `npm test -w @ancientpantheon/pythia src/automaton/khronoton/meteredRuntime.test.ts` passes —
    a metered `submit` that resolves records `byConsumer()["pythia-self"].transactions` == 1; a `submit`
    that throws records `byConsumer()["pythia-self"].failedTransactions` == 1 (and still rethrows). Create
    the test file if absent.
  - files: `apps/pythia/src/automaton/khronoton/meteredRuntime.ts`,
    `apps/pythia/src/automaton/khronoton/meteredRuntime.test.ts`
- [x] T4: `/pyth` route — expose `byConsumer`.
  - Add `byConsumer: ledger.byConsumer()` to the JSON body (alongside the unchanged `total`, `daily`,
    `unflushedDays`, `generatedAt`).
  - done when: `npm test -w @ancientpantheon/pythia src/routes/pyth.test.ts` passes — after a
    `recordSend(true, g, 1, "c")`, `GET /pyth` body has `byConsumer.c.transactions == 1`; with no per-
    consumer activity `byConsumer` is `{}`. Create the test file if absent.
  - files: `apps/pythia/src/routes/pyth.ts`, `apps/pythia/src/routes/pyth.test.ts`

## Wave 3 (depends on Wave 2)
- [x] T5: meter.ts send branch — resolve consumer, attribute sends (depends on T2's entry shape).
  - In the `send` branch resolve `const consumer = resolveConsumer(c.req.header(CONSUMER_HEADER));` once.
    Extend `TxTrackerLike.track` entries + the built entries with `consumer`. Pass `consumer` as the 4th
    arg to BOTH fallback `ledger.recordSend(...)` calls (the 2xx no-tracker/no-requestKeys optimistic path
    AND the 502 relay-rejected path).
  - done when: `npm test -w @ancientpantheon/pythia src/pyth/meter.test.ts` passes with new tests — a keyed
    2xx send whose consumer resolves to `"ouronetui"` hands `track()` entries each carrying
    `consumer:"ouronetui"`; a 2xx send with NO tracker records `recordSend(true, …, "ouronetui")`; a 502
    records `recordSend(false, …, "ouronetui")`; an unkeyed send resolves consumer `"direct"`. Existing
    meter tests still pass.
  - files: `apps/pythia/src/pyth/meter.ts`, `apps/pythia/src/pyth/meter.test.ts`
- [x] T6: Frontend — live Activity pulse + per-consumer breakdown (depends on T4's `/pyth` shape).
  - Add a poll loop tied to the Activity view lifecycle: when `#activity` becomes the active view (hook the
    same place `loadPyth()` is invoked on activation), start an interval (~4s) that GETs `/pyth`; when a
    displayed counter (`total.petitions`/`pondus`/`transactions`) is greater than the last poll, animate a
    count-up from old→new + a brief bump highlight; render a per-consumer transaction breakdown from
    `byConsumer` that updates live. Clear the interval when the view is hidden/navigated away (mirror how
    the activation poll timer is cleared). Do NOT alter the stone/air on-chain read or chart.
  - done when: `node --check apps/pythia/public/app.js` passes; a "pulse" block (live Petitions/Pondus/
    Transactions from the fleet ledger) + a per-consumer list render on the Activity view; the interval is
    started on view-show and cleared on view-hide (grep-verifiable start/clear pair); count-up + bump
    classes exist in `styles.css`; the existing stone/air markup/chart is untouched (diff review).
  - files: `apps/pythia/public/app.js`, `apps/pythia/public/styles.css`

## Notes
- Waves: T1 is foundational (recordSend signature + `byConsumer()`); T2/T3/T4 depend only on T1 and touch
  disjoint files; T5 depends on T2 (track entry shape), T6 depends on T4 (`/pyth` shape) — disjoint files.
- Scope guard (from design): TRANSACTIONS per-consumer only; no hub-earning for sends; no on-chain per-key
  schema; stone/air logic unchanged.
- Ships as a release (frontend + backend both change): bump all four version files + both changelogs, tag.
