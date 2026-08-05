# Handoff: Khronoton → on-chain Pyth ledger flush (V2 batch)

**To:** Pythia agent (Khronoton automatic triggering service).  
**From:** Ouronet Pact implementer.  
**Module:** `ouronet-ns.PYTHIA` (`PythiaLedgerV2` + `23_PYTHIA.pact`).  
**Talos entrypoint:** `ouronet-ns.TS01-C4.PYTHIA|A_Flush` (`TalosStageOne_ClientFourV6`).

Canonical Pact spec (tables, metrics, reads): [`HANDOFF-pact-pyth-ledger.md`](HANDOFF-pact-pyth-ledger.md).

---

## Overview

Khronoton maintains six cumulative counters per **UTC calendar day bucket** locally. On each flush tick, it sends a batch of day snapshots to the on-chain ledger:

* `A_Flush` is **batch**: it takes `entries[]`, where each entry contains:
  * `day` (UTC ordinal since `PYTHIA|LEDGER-EPOCH-START`)
  * `iz-complete` (open vs seal)
  * the six counters for that day (cumulative for that day)

Khronoton may split a large backlog across multiple transactions. Transaction ordering is not relied upon.

---

## Calendar day definition (UTC ordinal)

On-chain anchor: `PYTHIA|LEDGER-EPOCH-START` = `2026-07-21T00:00:00Z` (UTC). **Day 1** begins at that instant.

Compute locally (or verify against chain):

```text
calendar-day = 1 + floor( (t − epoch-start) / 86400 seconds )
```

In V2, the caller provides `day` explicitly inside each `PythFlushEntry`.

### How Pythia discovers epoch / current day

| Method | When to use |
|--------|-------------|
| **`PYTHIA.UR_PythLedgerEpochStart`** | Keyless read once at startup (or cache). Returns the on-chain `time` anchor — no hardcoding in agent config required. |
| **`PYTHIA.UR_PythCurrentDay`** | Keyless read at flush tick. Returns day ordinal for chain head block-time (UTC). Use to label the *current* open bucket. |
| **Hardcode epoch in agent** | Acceptable fallback if read gateway is down; must match on-chain constant exactly. |

Recommended: read `UR_PythLedgerEpochStart` once, cache it, compute day ordinals locally for event routing; cross-check with `UR_PythCurrentDay` at each :58 tick.

---

## Local storage (Pythia agent — cumulated data)

Pythia meters traffic in her **local database**. Khronoton reads that DB and flushes snapshots on-chain. This section is the agent-side contract.

### What to store locally

One row (or bucket) per **UTC calendar day ordinal** `D`:

```text
{ day: D
, iz-complete: bool          ; false while day D is still open; true after UTC midnight passed
, petitions: integer         ; cumulative for day D
, pondus: decimal            ; cumulative for day D (≤3 dp)
, transactions: integer
, gas-reserved: integer
, failed-transactions: integer
, wasted-gas-reserved: integer
, last-flushed-at: optional  ; agent bookkeeping — last successful on-chain flush for this day
}
```

**Critical:** counters are **running totals for that UTC day**, not deltas and not all-time totals. Increment locally as events arrive; reset bucket to zero only when day `D` ends and a new day begins.

### Event routing

On each incoming event with timestamp `t`:

1. Resolve `day = UC_PythDayOrdinal(t)` using cached `UR_PythLedgerEpochStart` (same formula as chain).
2. Increment the six counters on bucket `day`.
3. When UTC crosses midnight, mark the previous day `iz-complete: true` and start accumulating on `day + 1`.

### Flush handoff to Khronoton

At each :58 tick Khronoton builds `entries[]`:

1. Every **completed** local day not yet sealed on-chain → `{ day, iz-complete: true, …six counters… }`
2. The **current** open day → `{ day, iz-complete: false, …six counters… }`

Use `UR_PythTotal|LastDay` and `UR_PythDay(d)` (keyless reads) to discover which days already exist on-chain and whether they are sealed — skip or update accordingly.

### Recovery after local DB loss

1. Read `UR_PythTotal` + `UR_PythTotal|TotalMetrics` for headline all-time totals.
2. Read sealed days via `URD_ListPythDaily(from to)` (bounded range).
3. Re-seed local buckets for sealed days from chain snapshots.
4. Open day(s) since last seal: counters unknown locally — Pythia continues from zero for the current day only; sealed history is preserved on-chain.

---

## Khronoton schedule

Fire the flush engine **every hour at minute :58** (UTC).

On each tick, build `entries[]` like this:

1. all *completed* UTC day buckets → `iz-complete: true`
2. the *current* UTC day bucket (still accumulating metrics) → `iz-complete: false`

Multiple flushes per calendar day are expected and supported.

---

## What Khronoton sends (batch entries)

Via Talos / Cronoton signer (`pythia-cronoton-keyset`):

```pact
(TS01-C4.PYTHIA|A_Flush
  [
    { "day": <integer>
    , "iz-complete": true|false
    , "petitions": <integer>
    , "pondus": <decimal ≤3dp>
    , "transactions": <integer>
    , "gas-reserved": <integer>
    , "failed-transactions": <integer>
    , "wasted-gas-reserved": <integer>
    }
    ...
  ])
```

Or direct: `PYTHIA.A_Flush entries`.

---

## Metric semantics — cumulative for that UTC day

For each entry day `D`, all six counters must be the running totals for that UTC day bucket **so far** (since midnight UTC of day `D`), not deltas and not all-time totals.

---

## On-chain behavior (per entry)

For each `PythFlushEntry` in `entries[]`:

| Situation | On-chain effect |
|-----------|-----------------|
| Row absent for `day` | Insert `PythDaily`; set `iz-sealed` to `iz-complete`; add metrics to `PythTotal` |
| Row present and unsealed | Replace day metrics; if `iz-complete` is true, seal (`iz-sealed: true`); adjust total via `total − oldDay + newDay` |
| Row present and sealed | Reject the tx (sealed-day updates are not allowed) |

---

## Gas limit & sharding across multiple txs (2,000,000 gas)

`A_Flush` enforces a batch-length cap `length(entries) <= UR_PythMaxFlushBatch` (exporting `PYTHIA|MAX-FLUSH-BATCH`).

### Per-day gas cost (post-optimization)

Measured on local gas probe (`env-gasmodel "table"`):

| Path | Gas per day (approx) | Example batch |
|------|---------------------|---------------|
| Insert (new day rows) | ~103 | N=1000 → 103,167 gas |
| Update (replace open day) | ~185 | N=10000 → 1,846,022 gas |
| Seal (update + set `iz-sealed`) | ~217 | N=9234 → 1,999,897 gas |

The old ~80k/day figure came from `(keys ...)` enumeration inside validation and per-entry `enforce` calls. After batch-fold validation in the cap (`UEV_FlushEntries`) and `try`/read existence checks, cost dropped by ~800×. All validation remains enforced — sealed-day checks live inside `UEV_FlushEntries` (cap path), not in `XI_*`.

### Policy cap vs theoretical max

Theoretical 2M-gas ceiling (worst-case sealing path): ~9,234 entries per tx.

Operational cap (to avoid long flush intervals during backlog):

* `UR_PythMaxFlushBatch = 1000` day entries per tx (~103k–217k gas depending on path).

If you have more than 1000 day buckets to flush:

* `tx-count = ceil(totalDays / 1000)`
* Example: `300 / 1000 => ceil = 1` transaction; `5000 / 1000 => 5` transactions.

Submit shard txes **asynchronously** (do not depend on which tx is incorporated first). Order does not matter as long as:

1. each `day` ordinal appears in **exactly one** successful `A_Flush` entry across the shard set
2. the `iz-complete` value for a given day is consistent

Why it’s order-independent: the ledger updates totals per day by subtracting any existing day snapshot and adding the new one; `last-day` becomes the max day applied. For disjoint day sets, these updates commute.

---

## Validation rules (Pact enforces)

- All six counters ≥ 0  
- `pondus` ≤ 3 decimal places  
- `day ≥ 1`  
- If a row for `day` exists, it must be **unsealed** (sealed rows reject updates)  
- `length(entries) <= UR_PythMaxFlushBatch`  
- Signer must satisfy `PYTHIA|CRONOTON`

---

## Read API (keyless)

```pact
PYTHIA.UR_PythLedgerEpochStart      ;; time — UTC midnight for calendar day 1
PYTHIA.UR_PythCurrentDay            ;; integer (UTC calendar day for executing block-time)
PYTHIA.UR_PythMaxFlushBatch        ;; integer (max `entries` per A_Flush tx)
PYTHIA.UR_PythTotal                 ;; object{PythTotal}
PYTHIA.UR_PythTotal|TotalMetrics    ;; object{PythMetrics}
PYTHIA.UR_PythTotal|LastDay         ;; integer — last day ordinal on chain
PYTHIA.UR_PythDay(day)              ;; object{PythDaily} incl. iz-sealed
PYTHIA.URD_ListPythDaily(from to)   ;; bounded inclusive range
```

Daily row shape:

```pact
{ day: integer
, flushed-at: time          ;; block-time of latest flush for that day
, iz-sealed: bool           ;; true when the day is sealed
, metrics: object{PythMetrics}   ;; cumulative snapshot for that UTC day
}
```

---

## REPL reference

Integration tests: `REPL/Stage_01/[6.10]_PYTHIA.repl` + `[6.10b]_PYTHIA-ledger-v2.repl` (TX008–TX014).  
Gas probe: `REPL/Stage_01/[6.10]_PYTHIA-flush-gas-probe.repl`.  
Smoke runner: `REPL/_smoke_pythia_ledger.repl`.

Implementation notes: [`modules/stage01/pythia-ledger-flush.md`](modules/stage01/pythia-ledger-flush.md).

---

## Deploy note

First deploy of `23_PYTHIA.pact` + `06_TS01-C4.pact` (interfaces `PythiaLedgerV2` + `TalosStageOne_ClientFourV6`).

Greenfield: all eight `create-table` calls fire in the PYTHIA deploy tx.

