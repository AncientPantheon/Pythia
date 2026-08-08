# Activity tab — StoaChain / Foreign tiers + paginated pulse — Design

## Problem

The Activity tab stacks everything into one long scroll: the Live Pulse top-line cards, the
per-API-key "Activity by consumer" list, then the Stone/Air totals cards and the Daily Petitions
graph. As the number of consumers grows, that middle list grows unbounded and pushes the graph
far down the page — you scroll past a wall of keys to reach it. Two more gaps: a consumer row
shows only its (truncated) API key, not which **consumer lane** it belongs to, so they're hard to
tell apart; and there's no structure to grow into non-StoaChain ("foreign") chain activity.

## Approach

Restructure the single per-chain "Activity" section into a clearer tier layout, reusing the
existing header Tier-1/Tier-2 + URL-routed nav (`SECTIONS` / `TIER2` / `showTab` — every view is
its own deep-linkable `#section/sub` URL):

- **Tier-1 "StoaChain Activity"** — keeps the existing section key `activity` (relabelled), so
  current `#activity` deep links still resolve.
  - **Tier-2 "Live Pulse"** (`#activity/live-pulse`) — the top-line pulse cards + the "Activity by
    consumer" list, now (a) **paginated** at 10 rows/page (prev/next + page indicator), and (b)
    each row annotated with its **consumer lane**.
  - **Tier-2 "Statistics"** (`#activity/statistics`) — the Stone/Air totals cards + the Daily
    Petitions (Stone + Air) graph, moved out from under the consumer list so it's never buried.
- **Tier-1 "Foreign Blockchain Activity"** — new section key `foreign`.
  - **Tier-2 "Arweave"** (`#foreign/arweave`) — a "coming soon" placeholder (no data yet).

**Consumer lane:** the Live Pulse list joins each consumer (its Apollo account — the `byConsumer`
key) against the already-served on-chain dual-link roster (`URD_ListAllDualLinks`, which carries
`consumer-lane`, the same lane shown on the Connectors dual-link rows) and renders the lane beside
the key. Consumers with no matching lane (e.g. `Pythia (self)`, or an unmapped key) render cleanly
without one. (Exact match side — `standard-apollo` vs `smart-apollo` — pinned in planning.)

**Pagination:** reuse the Connectors dual-link list's pagination pattern (page-state + prev/next),
10 rows/page (a single constant — trivially switchable to 15).

Alternatives considered:
- Keep one Activity section and only paginate the list — rejected: leaves the graph below the
  (still long-lived) list and gives foreign chains nowhere to live.
- Make Live Pulse / Statistics in-panel toggles instead of Tier-2 sub-views — rejected: breaks the
  URL-is-source-of-truth deep-linking every other section follows.

## Acceptance criteria

- [ ] The header shows two Tier-1 buttons, **"StoaChain Activity"** and **"Foreign Blockchain
      Activity"**, in place of the single "Activity".
- [ ] "StoaChain Activity" shows Tier-2 buttons **"Live Pulse"** and **"Statistics"**, each its own
      deep-linkable URL (`#activity/live-pulse`, `#activity/statistics`); a bare `#activity`
      resolves to Live Pulse.
- [ ] "Foreign Blockchain Activity" shows a Tier-2 **"Arweave"** rendering a "coming soon"
      placeholder at `#foreign/arweave`.
- [ ] Live Pulse shows the top-line pulse cards + the consumer list; the list **paginates at 10
      rows/page** with working prev/next and a "page X of Y" (or equivalent) indicator, and does
      not paginate when there are ≤10 consumers.
- [ ] Each consumer row shows its **consumer lane** when the consumer maps to a dual-link that has
      one; rows with no lane render without breaking layout.
- [ ] Statistics shows the Stone/Air totals cards + the Daily Petitions graph; a long consumer list
      never pushes the graph down (it lives in a separate sub-view).
- [ ] The live-pulse heartbeat polls only while a sub-view that needs it is shown, and stops when
      the section is left (as today).
- [ ] Back/forward + direct-load of every new section/sub-view URL renders the correct view.

## Out of scope

- Real Arweave / foreign-chain data — placeholder only this round.
- Any server/ledger change — this is a frontend restructure over existing `/pyth` data plus the
  already-served dual-link roster (for lanes). The npm client is untouched.
- Sorting / filtering / search of the consumer list (pagination only for now).
- Old `#activity/<chainId>` deep links (e.g. `#activity/stoachain`) — they now resolve to the
  default Live Pulse sub-view rather than a chain; acceptable, the chain dimension is being
  replaced by the view dimension.
- The `read-gate-self-key` topic (separate design, still awaiting your approval).
