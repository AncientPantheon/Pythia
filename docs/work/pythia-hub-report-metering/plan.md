# Pythia — Hub report-metering prerequisites — Plan

Test: `npm test -w @ancientpantheon/pythia` (+ the client's own tests run under the root `npm test`).
Frontend (`public/app.js`, `public/styles.css`): `node --check` + manual (no harness).

## Wave 1
- [x] T1: Move `pondus()` + `CLASS_BASE` into `@ancientpantheon/pythia-client`; re-export from apps/pythia.
  - New `packages/pythia-client/src/pondus.ts` (pure `pondus()` + `CLASS_BASE` + internal `nonNeg`);
    export both from `packages/pythia-client/src/index.ts`. Rewrite `apps/pythia/src/pyth/pondus.ts` to
    `export { pondus, CLASS_BASE } from "@ancientpantheon/pythia-client"` and KEEP `round3` local.
  - done when: `npm test -w @ancientpantheon/pythia-client src/pondus.test.ts` passes (new: formula,
    per-request sqrt, classBase read=10/poll=5, non-neg guards); `apps/pythia` `pondus.test.ts` + all
    meter tests still pass importing from `./pondus.js`.
  - files: `packages/pythia-client/src/pondus.ts`, `packages/pythia-client/src/pondus.test.ts`,
    `packages/pythia-client/src/index.ts`, `apps/pythia/src/pyth/pondus.ts`

## Wave 2
- [x] T2: Ledger — per-consumer READ attribution.
  - Add `petitions` + `pondus` to `ConsumerTx` (+ `zeroConsumer`, `CONSUMER_FIELDS`). Extend
    `recordRead(pondusValue)` → `recordRead(pondusValue, consumer?)`: aggregate unchanged; when consumer
    is a non-empty string, `byConsumer[consumer].petitions += 1` and `.pondus += pondusValue`. Persistence
    already round-trips `byConsumer`; confirm new fields hydrate (default 0) and `nuke` clears them.
  - done when: `npm test -w @ancientpantheon/pythia src/pyth/ledger.test.ts` passes with new tests —
    `recordRead(w,"c")` bumps `byConsumer().c.petitions==1` + `.pondus==w`; `recordRead(w)` leaves
    byConsumer empty; a consumer with both reads and sends shows all six fields; legacy snapshot without
    the new fields loads them as 0.
  - files: `apps/pythia/src/pyth/ledger.ts`, `apps/pythia/src/pyth/ledger.test.ts`

## Wave 3 (depends on Wave 1 + Wave 2)
- [x] T3: Gateway meter — attribute keyed reads per consumer (depends T2).
  - In the read/poll branch resolve the consumer name (it already calls `resolveConsumer` for `keyed`)
    and pass it: `ledger.recordRead(pondusVal, consumer)`.
  - done when: `npm test -w @ancientpantheon/pythia src/pyth/meter.test.ts` passes with new tests — a
    keyed read attributes `byConsumer().<name>.petitions/pondus`; an anonymous read → `byConsumer().direct`;
    existing meter tests still pass.
  - files: `apps/pythia/src/pyth/meter.ts`, `apps/pythia/src/pyth/meter.test.ts`
- [x] T4: `POST /pyth/report` ingress + reporter allow-list (depends T1, T2).
  - New `apps/pythia/src/pyth/reporters.ts`: `loadReporters(rawEnv?)` → `Set<string>` from
    `PYTHIA_REPORTERS` (comma-separated; mirror `loadConsumerMap`). New
    `apps/pythia/src/routes/pythReport.ts`: `registerPythReport(app, { ledger, resolveConsumer, reporters })`
    — `POST /pyth/report`, body `{ transactions?: [{gasLimit,accepted,count?}], reads?: [{gasUsed,responseBytes,count?}] }`.
    Resolve consumer from `x-pythia-key`; if not in `reporters` → 403. Validate/bound (finite, ≥0, count
    1..1000, ≤1000 total entries) → 400 on violation. For each tx: `recordSend(accepted, gasLimit, count,
    consumer)`. For each read: `pondus({classBase: CLASS_BASE.read, gasUsed, responseBytes})` then
    `recordRead(pondus, consumer)` `count`× (bounded). Records into the ledger ONLY — never `slotUsage`.
    Wire in `index.ts` (`registerPythReport` + `loadReporters(process.env.PYTHIA_REPORTERS)`), positioned
    so no `/{chain}/{read|send|poll}` meter double-counts it (`/pyth/report` doesn't match OPERATIONAL_PATH).
  - done when: `npm test -w @ancientpantheon/pythia src/routes/pythReport.test.ts` + `src/pyth/reporters.test.ts`
    pass — an allow-listed reporter's batch records txs + reads into `byConsumer[reporter]` with recomputed
    pondus; a non-listed consumer → 403; anonymous → 403; malformed body / oversized batch → 400; bad
    numeric fields are rejected not recorded.
  - files: `apps/pythia/src/pyth/reporters.ts`, `apps/pythia/src/pyth/reporters.test.ts`,
    `apps/pythia/src/routes/pythReport.ts`, `apps/pythia/src/routes/pythReport.test.ts`,
    `apps/pythia/src/index.ts`
- [x] T5: Live pulse — show per-consumer petitions/pondus (depends T2 via `/pyth`).
  - Extend the pulse per-consumer rows to show petitions + pondus next to transactions; shorten
    apollo-account-shaped consumer names (reuse a shortener) in `consumerLabel`.
  - done when: `node --check apps/pythia/public/app.js` passes; each `pulse-crow` shows petitions/pondus/
    transactions; long names shortened; aggregate tiles + stone/air unchanged.
  - files: `apps/pythia/public/app.js`, `apps/pythia/public/styles.css`
- [x] T6: Doc — `organs/06 §6` three-path metering model.
  - Add the report path (relay / in-process seam / cross-process report) + the "hold node access + XP
    ledger → attribute locally, report one-way" rule.
  - done when: `organs/06-pythia-client-wire-in.md §6` describes all three paths.
  - files: `websites/Pantheon/docs/pantheonic-architecture/organs/06-pythia-client-wire-in.md`

## Notes
- Ships as a Pythia release (backend + client + frontend): bump all four version files + both changelogs,
  tag. The client bump is legitimate (new `pondus`/`CLASS_BASE` exports).
- Scope guard: fleet-ledger + byConsumer only; per-slot usage report untouched; no on-chain change.
