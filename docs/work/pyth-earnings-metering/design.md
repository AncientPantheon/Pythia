# pyth-earnings-metering — Design

## Problem
Pythia's Activity view shows generic HTTP accounting (requests, read/send/poll,
errors) — not the Pyth economy. The economy is **Petitions** (keyed read count →
PythLevel) and **Pondus** (read weight → Ergon/mint); sends are a separate relay
service. Pythia also has no durable ledger of what she has served (a DB wipe
erases it) and no admin control to reset the count or pause hub reporting. This
feature makes Pythia *meter* the economy, *display* it, and give the owner the
controls — and shapes the local ledger so a later on-chain flush (owner's Dalos/
Pact work) layers on cleanly.

## Approach
A keyless **PythLedger** accumulates six counters (mirrors the on-chain schema in
`docs/HANDOFF-pact-pyth-ledger.md`): `petitions`, `pondus` (decimal),
`transactions`, `gasReserved`, `failedTransactions`, `wastedGasReserved` — both a
running total and per-UTC-day deltas (so a future daily flush can read them).
Persisted atomically like the existing `StatsStore`.

A metering step records per operational request, keyless (reads only gas/bytes
from responses and gasLimit from the caller's signed command — never signs):
- **`/read` and `/poll`** → a Petition + Pondus = `classBase + √gas/2 + bytes/4096`
  per request, summed (classBase: read = 10 Pact-local, poll = 5 mempool-query;
  poll has gas 0). Round the surfaced window sum to ≤3 dp.
- **`/send`** → relay-accepted: `transactions` +1 and `gasReserved` += Σ gasLimit
  of the cmds; relay-rejected: `failedTransactions` +1 and `wastedGasReserved`
  += Σ gasLimit. "Failed" = **relay level** (node refused at submit), not on-chain
  revert.

The StoaChain **Activity** view is reworked to show **Petitions · Pondus**
(earning) and **Transactions · Gas relayed** (send service); the Errors card and
the separate Poll metric are removed. An ancient-gated **"StoaChain Earnings"**
admin section adds: (a) **Nuke the Pyth ledger** (reset all six to 0; server-
enforced ancient + confirm), and (b) a **Report-to-hub on/off** switch (persisted
setting; when off Pythia keeps counting locally).

Alternatives rejected: extend `StatsStore` with sums — rejected, it's a
count-only bucket store and pondus needs weighted decimal sums, so a dedicated
ledger is cleaner. Meter in one middleware by re-reading the response — kept open
for the plan (middleware vs per-handler hook), but pondus needs the parsed `gas`,
so a handler-adjacent tap is likely.

## Acceptance criteria
- [ ] The StoaChain Activity view shows **Petitions** and **Pondus** (reads) plus
      **Transactions** and **Gas relayed** (sends); the **Errors** card is gone and
      there is no separate **Poll** metric.
- [ ] A keyless `PythLedger` accumulates the six counters (pondus as an exact
      decimal), persists across a restart, and exposes both a running total and
      per-UTC-day deltas.
- [ ] Pondus for a read/poll equals `classBase + √gasUsed/2 + responseBytes/4096`
      (read classBase 10, poll 5), √ applied per request then summed — verified by
      a unit test against known gas/bytes inputs matching the handoff formula.
- [ ] A relay-accepted send increments `transactions` + `gasReserved` (Σ gasLimit
      from the signed cmds); a relay-rejected send increments `failedTransactions`
      + `wastedGasReserved` — verified by tests for both outcomes.
- [ ] The admin **StoaChain Earnings** section (ancient-gated) has a **Nuke**
      control that resets all six counters to 0 (rejected for non-ancient,
      server-side) and a **Report-to-hub** on/off switch whose state persists and
      is shown.
- [ ] `npm test -w @ancientpantheon/pythia` is green and the keyless CI scanner
      passes (metering reads gas/bytes/gasLimit only; no signing, no keys).

## Now IN scope (added after the buildout-doc review)
- **Per-slot usage reporter** — the real `HANDOFF-pythia-side-buildout.md` §4.3
  piece: a windowed per-slot meter (`keyed`/`anon`/`ok` + `keyedPondus`) and a
  `postUsage()` reporter POSTing signed reports to the live `POST /api/pythia/usage/`,
  gated by the earnings-tab toggle. The hub side is already built/live.
- **Self-polling tracker** — after relaying a send, poll its requestKey(s) to the
  mined outcome (success/fail + actual gas), upgrading the tx metrics from relay-
  level to execution-level.
- **Version bump** — 1.7.0 → 1.8.0 across the four version files + CHANGELOG.

## Out of scope
- **On-chain persistence** — the daily Dalos flush (`ouronet-ns.PYTHIA.A_Flush`) and
  reading the ledger back from chain are the owner's Pact/automaton work (spec:
  `docs/HANDOFF-pact-pyth-ledger.md`). Activity shows the LOCAL ledger for now; the
  on-chain total+daily read layers on next sprint.
- **Per-consumer Pondus / operator levels** — Activity stays fleet-wide totals; no
  PythLevel/Ergon/Opus display (per-operator, decided earlier).
