# Pyth live pulse + per-key transaction attribution — Design

## Problem
Two gaps in Pythia's Pyth-economy surface:

1. **Transactions have no per-consumer attribution.** Reads resolve a consumer (keyed → attributed
   at the hub), but sends land only in a single global `transactions` counter. When OuronetUI-main (or
   any consumer, or Pythia's own automaton) fires, you can't see *who* did what — only the aggregate.
2. **The Activity tab doesn't pulse.** It loads once and shows mostly the on-chain flushed ledger
   (which only moves on a daily `A_Flush`). Watching `#activity`, the operator can't see numbers climb
   live as activity arrives — there's no visible "heartbeat."

## Approach
Two coordinated parts, both **self-contained in Pythia** (no hub-economy change, no on-chain schema
change — per the chosen defaults: *count & display only*, *aggregate public + per-key breakdown shown*).

### Part A — per-key TRANSACTION attribution (Pythia-local)
- **Meter (`pyth/meter.ts`), send branch:** resolve the consumer at relay time (the same
  `resolveConsumer(CONSUMER_HEADER)` reads already use) and pass it to the tracker alongside each
  requestKey. Anonymous sends → `"direct"`.
- **`txTracker`:** carry `consumer` on each pending entry (extend `PendingTx` + the pending map). When a
  tx resolves (mines → success, or times out → failed), record the outcome **both** into the existing
  aggregate counters **and** into a per-consumer tally.
- **Ledger (`pyth/ledger.ts`):** add a persisted `byConsumer` map (`consumer → {transactions,
  failedTransactions, gasReserved, wastedGasReserved}`). Extend `recordSend(accepted, gas, count,
  consumer?)` — aggregate counters unchanged; when `consumer` is given, also bump its per-consumer
  bucket. Add a `byConsumer()` accessor. Persisted alongside the existing ledger file.
- **Pythia's own fires:** `meterChainRuntime` records under a fixed consumer label `"pythia-self"`, so
  her automaton (A_Link/A_Flush) is attributed distinctly from external consumers.
- **`GET /pyth`:** add a `byConsumer` block to the JSON (aggregate `total`/`daily` unchanged).

> Scope note: this attributes **transactions** per consumer. Per-consumer **reads** already exist at the
> hub (per-slot report) and are not duplicated into the fleet ledger — out of scope here.

### Part B — live Activity pulse
- The Activity tab starts a **poll loop** (~4 s) that GETs `/pyth` (the real-time fleet ledger, which
  includes un-flushed activity — the actual live pulse) while the tab is visible; it stops when the tab
  is hidden/navigated away (no wasted polling).
- When a displayed counter **increases**, animate it: a short **count-up** from the old to the new value
  + a brief highlight "bump," so the number visibly climbs as activity comes in.
- Show the live aggregate **pulse** (Petitions, Pondus, Transactions) prominently, sourced from the
  fleet ledger, and a **per-consumer transaction breakdown** (from `/pyth` `byConsumer`) that also
  updates live.
- The existing **stone/air on-chain display is unchanged** — the pulse is a live *fleet* layer on top;
  stone remains the flushed on-chain truth, air the pending backlog.

### Alternatives considered
- *Attribute sends optimistically at relay time (not on-mine).* Rejected — the codebase deliberately
  counts a transaction only when it mines (accuracy); per-key must follow the same resolution point, so
  we thread the consumer through the tracker rather than count early.
- *Push/SSE for the live pulse.* Rejected for now — a lightweight visibility-gated poll of the existing
  `/pyth` is simpler, needs no new endpoint/protocol, and 4 s cadence reads as "live" for a heartbeat.
- *Per-key transactions on-chain.* Rejected — would need a pact-module schema change (cross-repo) for no
  present benefit; the local ledger + `/pyth` is enough to see and demonstrate the pulse.

## Acceptance criteria
- [ ] A send relayed through `/stoachain/send` carrying consumer key **K** increments BOTH the aggregate
      `transactions` AND a per-consumer tally for **K** (visible in `/pyth` `byConsumer`) once it
      resolves (mine → transaction; timeout → failedTransaction).
- [ ] An anonymous (unkeyed) send is attributed to `"direct"`.
- [ ] Pythia's own automaton fires are attributed to `"pythia-self"` (distinct from external consumers)
      and still increment the aggregate `transactions`.
- [ ] `GET /pyth` returns a `byConsumer` breakdown alongside the unchanged `total` + `daily`.
- [ ] With `#activity` open, the displayed Petitions/Pondus/Transactions **visibly increment within a
      few seconds** of new activity, with a count-up + bump animation; navigating away stops the poll.
- [ ] The live pulse reflects the real-time fleet ledger (includes un-flushed activity); the on-chain
      stone/air display and its chart are unchanged.
- [ ] New unit tests cover: meter send→consumer resolution, tracker per-consumer recording (mine +
      timeout), ledger `byConsumer` accounting + persistence, `pythia-self` labelling. Full suite green.

## Out of scope
- Keyed sends **earning** at the hub (per-slot report / economy change) — not touched; sends stay
  non-earning.
- On-chain per-consumer schema / flushing per-key counts via `A_Flush`.
- Per-consumer **read** breakdown display (reads are attributed at the hub already).
- Any change to the stone/air on-chain reading logic or the chart.
