# How to add the Pyth-flush cronoton (operator guide)

You write the cronoton in the Khronoton console; Pythia fills the `entries` list from
her ledger at fire time. This is the "constructor filled with server data" — you never
type the entries by hand.

**Prerequisite:** deploy **v2.1.0** first. The `pyth-flush` resolver must be running in
the live container, or the cronoton fires with an empty `entries` list.

---

## The one idea

The `entries` argument to `A_Flush` is **not** typed into the cronoton. Instead:

1. The cronoton's pact code reads the list from the message payload: `(read-msg "entries")`.
2. You set the cronoton's **server resolver** to `pyth-flush`.
3. At each fire, Pythia's `pyth-flush` resolver builds the live list of day objects and
   injects it under the `entries` key. On confirmed success she drains those days locally.

So the list is a placeholder in your config; Pythia constructs it every fire.

---

## Cronoton fields to set

| Field | Value |
|---|---|
| **Pact code** | `(ouronet-ns.TS01-C4.PYTHIA\|A_Flush (read-msg "entries"))` — the Talos, gas-station-paid entrypoint. (Direct form: `(ouronet-ns.PYTHIA.A_Flush (read-msg "entries"))`.) |
| **Server resolver** | `pyth-flush` |
| **Payload / env-data** | `{ "entries": [] }` — an empty placeholder; the resolver overwrites the `entries` key at fire time. |
| **Signer** | The `pythia-cronoton-keyset` key from the Codex, signing the `PYTHIA\|CRONOTON` capability (the flush requires it). |
| **Gas** | Ouronet gas station (Pythia signs only; holds no gas). |
| **Schedule** | Once per day (UTC). Hourly `:58` also works — same-day flushes stack. |

**Simulate first.** Use the console's Simulate on the cronoton before enabling it — it
runs the resolver + a dry-run without submitting, so you can see the `entries` Pythia
would send and confirm the pact accepts them.

---

## What Pythia injects (the `entries` shape)

A list of day objects, exactly matching `PythiaLedgerV2.PYTHIA|S|PythFlushEntry`:

```json
[
  { "day": 1, "iz-complete": true,
    "petitions": 42, "pondus": 12.5, "transactions": 3,
    "gas-reserved": 4500, "failed-transactions": 0, "wasted-gas-reserved": 0 },
  { "day": 2, "iz-complete": false,
    "petitions": 7, "pondus": 2.0, "transactions": 1,
    "gas-reserved": 1500, "failed-transactions": 0, "wasted-gas-reserved": 0 }
]
```

- `day` — integer ordinal since the epoch `2026-07-21T00:00:00Z` (day 1 = that date).
- `iz-complete` — `true` for any past day (sealed on this flush), `false` for today (open).
- The six counters — cumulative for that UTC day, oldest day first, at most 1000 days/tx.

---

## Behavior you get

- **Once-per-day steady state:** each flush sends the current day (open) plus any earlier
  day not yet drained; on success those buckets are removed locally and counting resumes
  from zero.
- **Missed a day?** The next fire sends every accumulated day up to the present — one tx
  fills the gap (up to the 1000-day cap).
- **Testing / multiple flushes per day:** after a successful flush everything is drained;
  new reads accumulate for the current day, and the next flush stacks onto the same day
  on-chain. (This relies on `A_Flush` **adding** to an unsealed day — see the caveat.)
- **A failed fire drains nothing** — the same data retries next tick.
- The **StoaChain Earnings** panel warns if more than two days go unflushed.

---

## Two things to confirm on your side

1. **`A_Flush` must ADD (stack), not replace, an unsealed day.** The drain model sends the
   increment-since-last-flush and deletes it locally, so the chain must accumulate. Your
   "stacks on blockchain" description says it does; just confirm against the updated pact.
   (If it *replaces*, tell me — I'll keep the open day instead of draining it.)

2. **`pondus` is a decimal.** Pythia sends it as a JSON number (e.g. `12.5`, or `12` when
   whole). If the pact rejects a whole-number pondus on the integer-vs-decimal boundary,
   tell me and I'll encode it as a Pact decimal explicitly.

**Optional cleanup:** the ledger has been counting since before the `2026-07-21` epoch, so
a pre-epoch bucket (day 0) may exist — it's excluded from flushes (never sent) and doesn't
trip the warning. If you want a clean slate, hit **StoaChain Earnings → Nuke** once before
the first flush.
