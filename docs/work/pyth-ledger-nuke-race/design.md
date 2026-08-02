# pyth-ledger-nuke-race — Design

Quick-scale fix (single file, well-understood root cause, no design choices worth a full
shape/plan cycle) — this doc is a post-hoc record of what shipped, matching this repo's standing
convention of a paper trail per topic, per `docs/work/`.

## Problem

Reported by the operator: after clicking the admin "Nuke" button (`POST /admin/pyth/nuke`,
`PythLedger.nuke()`) to reset the local Pyth ledger and "start anew," the public landing page's
Activity panel (`GET /pyth`) kept showing much larger, older numbers (14 petitions / 1,395.372
pondus spanning several distinct pre-reset days) than the admin's own "Pyth Flush" panel (1
petition / 40.538 pondus, correctly scoped to the new epoch's Day 1).

Live investigation (`curl https://pythia.ancientholdings.eu/pyth`, confirmed uncached — Caddy is
the only proxy, `generatedAt` matched the request time) proved both panels read the exact same
`PythLedger` singleton and on-disk file (`pythia-pyth-ledger.json`) — this ruled out a caching
artifact or a second, un-nuked data source. The "Pyth Flush" panel's own epoch-filtering
(`unflushedDayCount()`/`previewEntries()` exclude any day bucket before the current on-chain epoch
anchor) explained the *shape* difference but not why pre-nuke day buckets (2026-07-21, 2026-07-30)
were still present in the map at all — `nuke()` unconditionally calls `this.days.clear()`.

## Root cause

A genuine race between "Nuke" and the blue-green deploy script
(`deploy/host/pythia-deploy.sh`): the INCOMING container is started and health-checked — during
which its `PythLedger` boots and loads the current ledger file into its own process memory — for
up to ~60s (30 × 2s polls) **before** Caddy cuts live traffic over to it. If an admin's Nuke click
lands in that window, it hits whichever container Caddy is *still* routing to (the OUTGOING one),
correctly clearing that process's memory and file. The INCOMING container, already booted with a
stale pre-nuke snapshot, has no way to know the on-disk truth changed underneath it. Once Caddy
cuts over, its own next `persist()` call — a served request accumulating to its 30s flush timer,
or its `SIGTERM` shutdown flush (`server.ts`'s `shutdown()` calls `pythLedger.persist()`
unconditionally) — blindly overwrites the just-nuked file with its own stale in-memory snapshot,
silently resurrecting the "nuked" data. This repo shipped several redeploys in quick succession
around the time of the reported nuke, each its own opportunity to cross this window.

## Approach

Add a monotonic `generation` counter to the persisted `LedgerSnapshot`, bumped only by `nuke()`.
Before every `persist()` write, first peek the **on-disk** generation (a cheap extra read of the
same small local file this class already reads/writes synchronously on every mutation). If the
on-disk generation is ahead of what this process last knew, another process has nuked the ledger
since this one last synced — reload the newer on-disk truth instead of writing this process's
stale snapshot over it, and skip the write (the reloaded state already matches disk). A process
that reloads discards whatever *it itself* recorded since going stale, rather than attempting to
merge — an accepted trade-off documented directly in `nuke()`'s and `persist()`'s doc comments:
losing a few seconds of one process's own traffic during a genuinely rare race window is far
better than silently resurrecting a whole nuked history indefinitely.

Alternatives considered:
- **Distributed lock / single-writer coordination** — correct in the limit but a large
  architecture change for a single-host, single-active-writer service; rejected as disproportionate
  to the actual failure mode.
- **Merge stale deltas onto the newer state instead of discarding** — requires tracking
  per-process deltas since last sync (a bigger refactor of the current whole-snapshot persist
  model) for a benefit (not losing a few seconds of traffic in a rare race) that doesn't justify
  the complexity here.

## Acceptance criteria

- [x] A test reproduces the exact production race (two `PythLedger` instances sharing one file;
      the "incoming" one boots before the "outgoing" one is nuked; the incoming one's own
      `persist()` must not resurrect the nuked data) — `apps/pythia/src/pyth/ledger.test.ts`,
      "PythLedger — nuke/deploy generation race" describe block.
- [x] Ordinary (non-racy) `persist()` calls are unaffected — writes proceed normally when the
      on-disk generation is not ahead of this process's own.
- [x] Old, pre-fix on-disk files with no `generation` field load and behave correctly (treated as
      generation 0).
- [x] Full suite + typecheck green.

## Out of scope

- Fixing the deploy script itself to close the timing window (e.g., delaying the incoming
  container's boot, or draining before allowing writes) — the ledger-level self-heal fixes the
  *consequence* regardless of exactly how the window gets crossed, which is more robust than
  trying to eliminate deploy-script timing windows one at a time.
- Cleaning the currently-live stale data — that requires the operator to click "Nuke" again
  themselves (no SSH/host access from this session); this fix only prevents *recurrence* on future
  deploys.
