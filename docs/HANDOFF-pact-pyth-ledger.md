# Handoff: the on-chain Pyth Ledger (in the `PYTHIA` Pact module)

**To:** the Pact implementer (Cursor agent).
**From:** Pythia (the keyless read/relay gateway).
**Owner:** extends the existing **`ouronet-ns.PYTHIA`** module with the tables +
functions below, then wires the flush into the DALOS Automaton.

## Why

Pythia meters the service she provides — six counters (below) — and keeps a
running tally in her **local** database. If that DB dies, the tally is erased.
The fix: persist it **on chain** (chainweb is excellent at durable integers/
decimals). Pythia accumulates the six counters locally each day; once a day the
**DALOS Automaton** submits ONE transaction that (a) appends a per-day row and
(b) increments a running total. Pythia's Activity page then **reads these tables
back through her own keyless `/read` gateway** — so even after a DB wipe the
economic history survives, publicly verifiable on chain.

**The flush = Pythia sends the day's six deltas to the DALOS Automaton, and Dalos
executes `(ouronet-ns.PYTHIA.A_Flush …)` to update the on-chain data.** Pythia is
**keyless** — she never signs. She SIGNALS Dalos; Dalos signs + submits the
`A_Flush` tx. `A_Flush`'s write is therefore capability-guarded to the Dalos
signer; the read functions are public (Pythia dirty-reads them with no keys).

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
> exact arbitrary-precision, so incrementing a running `decimal` never drifts.
> "Failed" here means **relay-level** rejection (the node refused the tx at
> submit), not on-chain execution revert — but the module doesn't need to know
> that; it stores whatever integers/decimal Pythia hands it.

## Two tables

### 1. `pyth-daily` — one row per operating day (drives the daily activity chart)

- **Key:** the day ordinal as a string — `"1"`, `"2"`, `"3"`, … (the Nth day
  Pythia has flushed). Monotonic, no gaps.
- **Row = that day's DELTA** (the amount served *that day*, not cumulative):

  ```
  { day:integer                 ; the ordinal, same as the key as an int
  , at:time                     ; UTC timestamp of the flush
  , petitions:integer
  , pondus:decimal
  , transactions:integer
  , gas-reserved:integer
  , failed-transactions:integer
  , wasted-gas-reserved:integer }
  ```

### 2. `pyth-total` — a single running-total row (the grand totals)

- **Key:** the chain id constant — `"stoachain"` (one ledger per chain; only
  StoaChain today, so Arweave/others slot in later with no schema change).
- **Row = the CUMULATIVE sum** of the six metrics (no `day`/`at`), incremented
  every flush:

  ```
  { petitions:integer, pondus:decimal, transactions:integer
  , gas-reserved:integer, failed-transactions:integer
  , wasted-gas-reserved:integer }
  ```

## Write path — `A_Flush`, one Dalos-guarded function called once per day

```pact
(defcap WRITE-LEDGER () ; guard the flush to the Dalos Automaton signer only
  (enforce-guard (dalos-automaton-guard)))

;; A_ prefix = automaton-callable (matches the module's convention). The DALOS
;; Automaton calls (ouronet-ns.PYTHIA.A_Flush …) once per day.
(defun A_Flush
  ( day:integer at:time
    petitions:integer pondus:decimal
    transactions:integer gas-reserved:integer
    failed-transactions:integer wasted-gas-reserved:integer )
  (with-capability (WRITE-LEDGER)
    ;; 1) append the daily row — INSERT (not write) so re-submitting the same
    ;;    ordinal FAILS: the daily append is idempotent against a double flush.
    (insert pyth-daily (int-to-str 10 day)
      { "day": day, "at": at
      , "petitions": petitions, "pondus": pondus
      , "transactions": transactions, "gas-reserved": gas-reserved
      , "failed-transactions": failed-transactions
      , "wasted-gas-reserved": wasted-gas-reserved })
    ;; 2) increment the running total by the same deltas (create-on-first-write)
    (with-default-read pyth-total "stoachain"
      { "petitions": 0, "pondus": 0.0, "transactions": 0, "gas-reserved": 0
      , "failed-transactions": 0, "wasted-gas-reserved": 0 }
      { "petitions" := tPet, "pondus" := tPon, "transactions" := tTx
      , "gas-reserved" := tGas, "failed-transactions" := tFail
      , "wasted-gas-reserved" := tWaste }
      (write pyth-total "stoachain"
        { "petitions": (+ tPet petitions)
        , "pondus": (+ tPon pondus)
        , "transactions": (+ tTx transactions)
        , "gas-reserved": (+ tGas gas-reserved)
        , "failed-transactions": (+ tFail failed-transactions)
        , "wasted-gas-reserved": (+ tWaste wasted-gas-reserved) }))))
```

Notes for the implementer:
- **`insert` for the daily row** (not `write`/`update`) — a repeated day ordinal
  must error, so a double-flush can't corrupt the series.
- **`WRITE-LEDGER`** binds to the Dalos Automaton's keyset/guard — the only
  signer permitted to flush. Substitute your project's real guard.
- Keep the module **namespaced** consistently with the rest of the Ouronet
  modules (e.g. `ouronet-ns.PYTH-LEDGER` or as the owner directs).

## Read path — public / keyless (Pythia reads these through her own `/read`)

Name these per the module's read convention (the existing reads are `URD_…`,
e.g. `URD_ListAllDualLinks`) — suggested:

```pact
(defun URD_GetPythTotal () (read pyth-total "stoachain"))          ; the grand totals
(defun URD_GetPythDay (day:integer) (read pyth-daily (int-to-str 10 day)))
(defun URD_ListPythDaily (from:integer to:integer) ...)           ; bounded, for the chart
(defun URD_LatestPythDay () ...)                                  ; the current ordinal
```

- Reads are **public read-only** (no capability) so Pythia can dirty-read them
  with no keys.
- Prefer a **bounded** range read (`URD_ListPythDaily`) so Pythia can ask for only
  the last N days and keep the response small; avoid an unbounded "read all".
- Expose `URD_LatestPythDay` so Pythia (and Dalos) know the next ordinal to write.

## Integration contract (for the owner wiring Dalos)

1. Pythia accumulates the six counters locally during the day.
2. At the daily boundary Pythia signals Dalos with `{ day, at, …six deltas }`.
3. Dalos executes `(ouronet-ns.PYTHIA.A_Flush day at …six deltas)` (signed) →
   appends the daily row + bumps the total.
4. Pythia's Activity reads `URD_GetPythTotal` (headline) + `URD_ListPythDaily`
   (chart), adding today's not-yet-flushed local buffer on top.

*One ledger per chain via the `pyth-total` key; the daily table is global (or
add a `chain` field if you want per-chain daily rows later).*
