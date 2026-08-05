# Handoff: the on-chain Pyth Ledger (in the `PYTHIA` Pact module)

> **Flush service contract (Khronoton):** calendar-day derivation, :58 schedule, cumulative
> day metrics, same-day replace + sealing, batch sharding — see
> [`HANDOFF-pythia-khronoton-flush.md`](HANDOFF-pythia-khronoton-flush.md).

**To:** the Pact implementer (Cursor agent).
**From:** Pythia (the keyless read/relay gateway).
**Owner:** extends the existing **`ouronet-ns.PYTHIA`** module with the tables +
functions below, then wires the flush into the DALOS Automaton.

**Deploy interface:** `PythiaLedgerV2` (ships in `23_PYTHIA.pact`; not yet on chain).

## Why

Pythia meters the service she provides — six counters (below) — and keeps a
running tally in her **local** database. If that DB dies, the tally is erased.
The fix: persist it **on chain** (chainweb is excellent at durable integers/
decimals). Pythia accumulates the six counters locally each day; Khronoton submits
batch transactions that upsert per-day rows and adjust a running total. Pythia's
Activity page then **reads these tables back through her own keyless `/read` gateway**.

**The flush = Pythia sends day snapshots to the DALOS Automaton; Dalos executes
`(ouronet-ns.PYTHIA.A_Flush entries)` to update the on-chain data.** Pythia is
**keyless** — she never signs. She SIGNALS Dalos; Dalos signs + submits the
`A_Flush` tx. `A_Flush`'s write is capability-guarded to the Cronoton signer;
read functions are public (Pythia dirty-reads them with no keys).

## The six metrics (Pythia computes these; the module just stores them)

| field | type | meaning |
|---|---|---|
| `petitions` | integer | keyed READS served (request count) |
| `pondus` | decimal | READ weight served — `Σ (classBase + √gas/2 + bytes/4096)`, ≤3 dp |
| `transactions` | integer | txs **relay-accepted** by a node |
| `gas-reserved` | integer | Σ `gasLimit` of the accepted txs |
| `failed-transactions` | integer | txs **relay-rejected** (node refused at submit) |
| `wasted-gas-reserved` | integer | Σ `gasLimit` of the rejected txs |

> `pondus` is a **`decimal`** — do NOT scale it to an integer. Pact decimals are
> exact arbitrary-precision. "Failed" here means **relay-level** rejection.

## Two tables

### 1. `PYTHIA|T|PythDaily` — one row per UTC calendar day

- **Key:** day ordinal as string (`"1"`, `"2"`, …).
- **Row:**

  ```
  { day:integer
  , flushed-at:time
  , iz-sealed:bool
  , metrics:object{PYTHIA|S|PythMetrics} }
  ```

### 2. `PYTHIA|T|PythTotal` — running totals

- **Key:** `"stoachain"`.
- **Row:**

  ```
  { total-metrics:object{PYTHIA|S|PythMetrics}
  , last-day:integer }
  ```

`PYTHIA|S|PythMetrics` is the shared six-counter schema.

## Write path — batch `A_Flush` (PythiaLedgerV2)

```pact
(defun A_Flush:string
  (entries:[object{PythiaLedgerV2.PYTHIA|S|PythFlushEntry}])
  (with-capability (PYTHIA|A>FLUSH entries)
    (XI_FlushPythLedger entries)))
```

Each entry carries `day`, `iz-complete`, and the six counters (cumulative for that UTC day).

Cap validates via `(enforce (UEV_FlushEntries entries) …)` — see
[`modules/stage01/pythia-ledger-flush.md`](modules/stage01/pythia-ledger-flush.md).

Per entry:
- **Insert** when row absent.
- **Replace** when row present and unsealed; seal if `iz-complete`.
- **Reject** when row sealed (validated in cap, not in `XI_*`).

Guard with **`pythia-cronoton-keyset`** (`PYTHIA|CRONOTON`).

Never use bare `object` — always `object{PythiaLedgerV2.PYTHIA|S|…}`.

## Read path — public / keyless

```pact
PYTHIA.UR_PythLedgerEpochStart      ;; time — UTC midnight for calendar day 1
PYTHIA.UR_PythCurrentDay            ;; UTC calendar day for block-time
PYTHIA.UR_PythMaxFlushBatch         ;; max entries per A_Flush tx (1000)
PYTHIA.UR_PythTotal                 ;; object{PythTotal}
PYTHIA.UR_PythTotal|TotalMetrics    ;; object{PythMetrics}
PYTHIA.UR_PythTotal|LastDay         ;; highest day ordinal written
PYTHIA.UR_PythDay(day)              ;; object{PythDaily}
PYTHIA.URD_ListPythDaily(from to)   ;; bounded inclusive range
```

Reads are **public read-only** (no capability).

## Integration contract (for the owner wiring Dalos)

1. Pythia accumulates the six counters locally per UTC day bucket.
2. At each :58 tick Khronoton builds `entries[]` (completed days sealed + current day open).
3. Dalos executes `(TS01-C4.PYTHIA|A_Flush entries)` (signed, sharded if >1000 days).
4. Pythia's Activity reads totals + daily range, adding today's not-yet-flushed local buffer.

## REPL

- `REPL/Stage_01/[6.10]_PYTHIA.repl` + `[6.10b]_PYTHIA-ledger-v2.repl`
- Gas probe: `REPL/Stage_01/[6.10]_PYTHIA-flush-gas-probe.repl`
