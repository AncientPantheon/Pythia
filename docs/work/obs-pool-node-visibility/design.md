# obs-pool-node-visibility — Design

## Problem
Pythia receives a hub node feed but the admin only sees a **count** ("Feed live — N hub
nodes"). The operator can't see *which* nodes, their addresses, whether each is reachable,
or *why* a node is red. Worse, the read pool's per-node reachability currently leaks into
**Update & Deploy** (via the pool-aware `/healthz` pair) under a **stale note** claiming it
"reports only the two config seed nodes." So when the hub fixes what it advertises (per
`docs/HANDOFF-hub-node-feed-reachability.md`), the operator has no screen to watch nodes go
green — and the node info is in the wrong place.

## Approach
Give the **Observation Pool** a live, per-node table of the hub fleet with accurate
reachability, and take node info out of Update & Deploy.

1. **Retain the full advertised slot list for display** — separate from the usable-for-reads
   set the pool rotates across. Today `fetchNodes` filters to a usable count; keep the raw
   advertised slots available so the admin can see *all* nodes, including red/not-at-tip ones.
2. **Per-node reachability probe** — for each advertised slot, `GET <url>/info` over HTTPS,
   3s timeout, require 2xx, **cert validated** (the exact contract the hub handoff documents),
   capturing `reachable` **plus a reason**: `refused` / `timeout` / `cert` / `http <status>`.
3. **Ancient-gated `GET /admin/hub-nodes`** returns the enriched list per node: `id` (IP),
   `url`, `operator`, `atTip`, `height`, `reachable`, `reason`, and the earnings fields
   (`operatorPythXP`, `operatorPythLevel`, `slotRewardedRequests`, `slotStoicismEarned`,
   `earnedSince`) **passed through when the hub returns them, absent otherwise** (the hub
   hasn't shipped them yet — `docs/HANDOFF-hub-nodepool-earnings.md`).
4. **Observation Pool table** — one row per node: reachability dot + reason, IP, server URL,
   operator, at-tip, and earnings columns when present (else a graceful "awaiting hub").
   Sorted highest-earning first when earnings exist, else reachable-first.
5. **De-conflate Update & Deploy** — drop the node-reachability rows there, keep the live
   **Version** readout + the Deploy controls, and fix the stale `/healthz` note.

Alternatives rejected: probe reachability inside the existing `/healthz` poller (that's
picked-pair liveness for routing, not an all-nodes inventory — conflating them muddies both);
show only usable at-tip slots (the operator explicitly needs to see *all* advertised nodes,
including red ones, to diagnose the hub).

## Acceptance criteria
- [ ] The Observation Pool shows one row per advertised hub node with: reachability dot +
      failure reason, IP (`id`), server URL, operator, at-tip.
- [ ] A node failing the probe shows red with the **specific reason** (refused / timeout /
      cert / http-status), matching what a direct `curl <url>/info` shows from the box.
- [ ] When the hub returns earnings fields, each row shows the operator's PythXP/level + the
      slot's stoicism / rewarded-requests, **sorted highest-earning first**; when absent, the
      columns show "awaiting hub" and rows sort reachable-first — no error, graceful degrade.
- [ ] Update & Deploy no longer shows node-reachability rows; its stale "config seed nodes"
      note is corrected; the **Version** readout and **Deploy** controls remain.
- [ ] `GET /admin/hub-nodes` is ancient-gated — 401 without a session, 403 for non-ancient.
- [ ] `npm test -w @ancientpantheon/pythia` green; keyless CI scanner passes.

## Out of scope
- **Topic 2 (security-tab-controls):** surfacing the hub-secret update on the Security tab;
  master-key rotation via the host-spool pattern. Shaped separately after this ships.
- Making the hub nodes actually reachable — that's the hub agent's job
  (`docs/HANDOFF-hub-node-feed-reachability.md`); this topic only makes their state *visible*.
- Changing the read/rotation mechanism (already per-read round-robin, which is correct).
