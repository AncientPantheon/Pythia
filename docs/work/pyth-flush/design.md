# Pyth ledger flush (Khronoton drain model) — Design

## Problem
Pythia meters six counters per UTC day in her local ledger (`pyth/ledger.ts`). The
Khronoton must periodically send those day-buckets on-chain via `PYTHIA|A_Flush(entries)`
so the on-chain `PythiaLedgerV2` ledger stays current. Nothing wires the local ledger to a
Khronoton flush transaction yet, and the entries must be built live at fire time.

## Approach — the drain model (owner-chosen)
Pythia never tracks which on-chain days are "sealed". Instead: **if she holds data for a
day, it hasn't been flushed.** A flush sends what she holds; on confirmed success she
drains (removes) exactly what was sent; new traffic accumulates on a fresh slate.

Mechanism: the Khronoton package supports a **single-tx server resolver** (`serverResolver`
on a cronoton) that fills payload keys from live server data at fire time. The flush is a
cronoton whose pact code calls `A_Flush` with an `entries` key that a **`pyth-flush`
resolver** fills from the ledger.

**Fire path (per tick):**
1. `resolve()` — snapshot the current day-buckets (oldest ≤1000 days), build `entries[]`
   (each `{ day, iz-complete, …6 counters }`), return them as the `entries` payload +
   the snapshot as the settle `plan`. **Does not modify the live buckets.**
2. The Khronoton simulate-guards, fires, and listens for the result.
3. `settle(plan)` — called **only on confirmed success**: subtract the snapshotted amounts
   from the live buckets (drain what actually landed); delete any bucket that reaches zero.
   Traffic that arrived between resolve and settle is preserved (it's the difference).
4. On failure `settle` is not called → nothing drained → the same data retries next tick.

- `iz-complete` for a bucket = its day ordinal `< today's` ordinal (past day = complete;
  today = open). Day ordinal = `1 + floor((t − EPOCH)/86400s)`, `EPOCH = 2026-07-21T00:00Z`.
- Entry keys are the Pact schema's **kebab-case** (`iz-complete`, `gas-reserved`,
  `failed-transactions`, `wasted-gas-reserved`); `pondus` is a decimal ≤3dp.

**Rejected alternative:** chain cross-read of `UR_PythTotal|LastDay` + sealed-day checks
each tick (the handoff's default). Owner rejected it — the drain model needs no chain read.

### Load-bearing assumption (confirmed by owner: "stacks on blockchain to the current day")
On-chain `A_Flush` **adds/stacks** metrics onto an unsealed day (not replace), so that
draining + re-sending the current day's later increments accumulates correctly, and a
day's final flush (`iz-complete: true`) adds the tail and seals. The design is built on
this. (If the pact instead *replaced*, same-day re-flushes would lose data.)

## Acceptance criteria
- [ ] The ledger exposes a flush snapshot: `beginFlush()` returns `entries[]` in the exact
      Pact `PythFlushEntry` shape (kebab keys, integer `day` ordinal, `iz-complete` derived,
      `pondus` ≤3dp), oldest-first, capped at 1000 days, plus a drain token.
- [ ] `commitFlush(token)` subtracts the sent amounts and deletes zeroed buckets; concurrent
      increments between snapshot and commit are preserved.
- [ ] A `pyth-flush` single-tx resolver is registered so a cronoton naming it fills the
      `entries` payload at fire time and drains on confirmed success.
- [ ] A failed/unfired flush leaves the ledger untouched (retried next tick).
- [ ] The admin surfaces the unflushed-day count and warns when it exceeds 2 full days.
- [ ] The owner has a written guide for creating the flush cronoton (schedule, pact code,
      resolver name, signer/gas, keyset) — keys set by the owner.

## Out of scope
- Multi-tx sharding beyond the 1000/tx cap (days accrue 1/day → ~2.7 years of runway).
  The resolver sends the oldest ≤1000; the >2-day UI warning covers a stuck flush.
- Chain-read recovery after a `/data` wipe (the drain model tolerates it: Pythia resumes
  from an empty slate; sealed history is preserved on-chain).
- Writing the cronoton itself (owner writes it in the Khronoton UI with my guide + keys).

## Decisions
- Cadence: **once per day** (owner). Hourly `:58` also works — multiple flushes/day are
  supported and stack. The cron schedule is the owner's cronoton config, not baked in.
- Batch: single-tx, cap 1000, oldest-first. UI warns at >2 unflushed days.
