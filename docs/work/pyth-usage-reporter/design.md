# pyth-usage-reporter — Design

## Problem
Pythia meters the Pyth economy locally (v1.8.0) but never REPORTS it to the hub,
so operators mint nothing. The hub's `POST /api/pythia/usage/` is live and expects
a **per-slot** report (`keyed`/`anon`/`ok` + `keyedPondus`) attributing served
reads to each node operator by slot id, in **non-overlapping, immutable windows**.
Pythia can't produce that today: `dial()` discards which node served each read, so
there is no per-slot attribution, and there is no reporter. This is the money path
— over-attribution mints real B.UNA/Stoicism, so the window contract is load-bearing.

## Approach
Least-invasive plumbing + a windowed reporter, keyless throughout.

1. **Served-slot plumbing.** Add an optional `onServed(node)` callback to `dial`/
   `dialNodes` — fired with the node whose response arrived (transport OK), no
   change to the return type or the 15 callers. The read + poll handlers pass it to
   stash the served node id on the request context. `NodePool` retains each hub
   slot's `operator` and exposes `operatorForSlot(id)` (null when the id is not a
   current hub slot — i.e. an Upload-Pool/seed node, which never earns).
2. **Per-slot windowed meter** (`stats/slotUsage.ts`): `Map<slotId, {operator,
   keyedRequests, anonRequests, ok, keyedPondus}>` + a window-start time. `drain()`
   returns `{ period:{from,to}, slots:[…] }` and RESETS the window. Only READS on a
   hub slot are recorded (keyed vs anon by `x-pythia-key`; `keyedPondus` = the read's
   PONDUS_V1 for keyed only). Seeds/upload nodes, sends, and polls are excluded.
3. **HMAC reporter.** `serviceClient.postUsage(report)` signs the §2.1 envelope and
   POSTs `/api/pythia/usage/`. `usageReporter.ts` runs a ~60s timer: drain →
   `postUsage` a contiguous window; honor the **report toggle** (skip when off) and
   the window contract (a transient failure retries the SAME window with identical
   counts — never merged). Empty windows are skipped.
4. **Release v1.9.0.**

Alternatives rejected: change `dial()`'s return type to include the served id —
rejected, it touches all 15 callers; the optional callback is surgical. Meter in the
existing `pythMeterMiddleware` — rejected, that ledger is fleet-wide and includes
sends/polls; the per-slot meter is a distinct windowed shape (§4.3).

## Acceptance criteria
- [ ] `dial`/`dialNodes` call `onServed(node)` with the node whose response arrived;
      absent the callback, behavior is byte-identical (the 15 callers are unaffected).
- [ ] A read served by a hub slot stashes that slot id on the context; a read served
      by an Upload-Pool/seed node stashes nothing hub-attributable (`operatorForSlot`
      returns null for it).
- [ ] `slotUsage` records only hub-slot READS — keyed vs anon, an `ok` count, and
      `keyedPondus` (keyed reads only); `drain()` returns `{period, slots}` and resets.
- [ ] `serviceClient.postUsage` sends the signed §2.1 envelope to `/api/pythia/usage/`
      with each slot's `id` echoed byte-identically + `keyedPondus` + `pondusVersion:1`.
- [ ] The reporter POSTs a contiguous non-overlapping window every ~60s; **skips
      entirely when the report toggle is OFF**; retries a failed window with identical
      counts (idempotent); skips empty windows.
- [ ] `npm test -w @ancientpantheon/pythia` green; keyless CI scanner passes; the
      full flow validated once against the live hub before release.

## Out of scope
- On-chain persistence (`A_Flush`) — owner's Pact/automaton work.
- Metering sends/polls into the per-slot report — reads only earn (§4.3).
- A Pythia-side display of hub-computed levels/rewards — separate, optional.
