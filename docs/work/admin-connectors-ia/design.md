# admin-connectors-ia — Design

> Topic 3 of **pythia-constructor-service** (owner-directed round, before update-deploy /
> security-vault / embeddable-verifiers). Admin IA rework: chain-scoped connector grouping, the
> real routing rule-book on display, Mnemosyne-style lined entries, and the Version+Deploy merge.

## Problem
The admin landing treats **Observation Pool** and **Upload Pool** as top-level functions, but both
are StoaChain-specific — the IA has no place for the Arweave (and future) connectors Pythia will
grow. The **actual routing/failover rules** (what serves reads when the hub feed is up, what happens
when it fails, why sends only ever use the Upload Pool, why the seeds can't be removed) are written
nowhere an operator can see — the owner explicitly wants the real rules displayed. The landing
renders as a **card grid**, but the owner wants Mnemosyne's **lined-entry list** look. And
**Version & Network** duplicates territory that belongs inside **Update & Deploy** (owner decided
to merge them).

## Approach
All within the existing vanilla single-page admin (admin.html + admin.js + styles.css), extending
the topic-2 scaffold:

- **IA regroup.** Landing gets 4 lined entries: **Verifiers · Blockchain Connectors ·
  Update & Deploy · Security** *(planned)*. Blockchain Connectors opens a chain list (StoaChain
  today; the list renders from a config array so future chains slot in). Opening **StoaChain** shows
  one chain page holding the **Observation Pool** and **Upload Pool** sections (existing
  load/render/wire logic reused; seeds already render "seed"/"baked in" badges — kept prominent)
  plus the **routing rule-book** panel.
- **Nested hash routes.** `#connectors` (chain list) → `#connectors/stoachain` (chain page); the
  router learns nested names; Back walks up one level. Legacy hashes (`#observation`, `#upload` →
  `#connectors/stoachain`; `#version` → `#update-deploy`) redirect so old bookmarks don't break.
- **The rule-book panel** — the REAL rules, extracted from the code (dial/nodePool/hub/send/store,
  verified 2026-07-16 with file:line evidence), rendered as a static readable list on the StoaChain
  page. Headline rules it must state: reads/polls rotate the hub fleet as primary leg with an
  Upload-Pool fallback leg when the feed is live; feed off/erroring/zero-slots → both legs rotate
  the Upload Pool; both empty → 503 `pythia_no_read_node`; failover is transport-failure-only (node
  HTTP errors are returned verbatim), one retry, 10s per-attempt timeout, both-fail → 502
  `pythia_pool_exhausted`; a failed feed poll keeps serving the last-good slot list; sends go ONLY
  to the Upload Pool, in add order, fail-closed 503 `pythia_no_tx_sender` when empty, and never
  touch hub read nodes; the two seeds (node1/node2.stoachain.com) are permanent, cannot be disabled
  or removed, and serve reads whenever the feed is off; feed refresh 60s, health poll 15s, no
  blacklist/circuit-breaker. Kept in one `STOACHAIN_RULES` array in admin.js with a "verified
  against code" date note.
- **Version+Deploy merge.** Remove the separate Version & Network entry; the **Update & Deploy**
  view opens (no longer a planned-inert tile) and shows the version/network readout — relabeled
  honestly as **seed-pair health** (the rule-book found `/healthz` reports only the seed pair, which
  can differ from the pool actually serving reads) — plus a clearly-marked deploy-controls area that
  says the on-box deploy lands in the next round (topic: update-deploy).
- **Lined entries.** Restyle the landing (and the chain list) from the card grid to Mnemosyne-style
  vertical rows — full-width entry per function: icon left, title + blurb, subtle hover — the
  `.mnemo-admin-tilelist` look, in Pythia's own tokens.

**Alternatives considered:**
- *Per-chain top-level tiles (StoaChain tile, Arweave tile…)* — rejected: re-clutters the landing
  as chains grow; the owner asked for one Connectors group.
- *Serving the rule-book from a backend endpoint* — rejected: it documents code behavior, so it
  changes only with code; a constant in admin.js keeps it one hop from the router with zero API
  surface. Drift risk accepted and mitigated by the verified-date note.
- *Keeping Version & Network separate* — rejected by owner (merge decided).

## Acceptance criteria
- [ ] The admin landing renders **lined entries** (vertical full-width rows: icon, title, blurb),
      not a card grid, with exactly: Verifiers · Blockchain Connectors · Update & Deploy · Security
      (Security still badged "planned"/inert).
- [ ] **Blockchain Connectors** opens a chain list showing **StoaChain** as a lined entry (structure
      renders from a config array a future Arweave entry can be added to); opening StoaChain shows
      the **Observation Pool** and **Upload Pool** sections on one page with every existing action
      still working (hub save/refresh; tx-sender add/enable/remove/bulk) and the two **seed nodes
      visibly badged** as baked-in/protected.
- [ ] The StoaChain page displays the **routing rule-book** — including at minimum: the feed-active
      read rotation (hub primary leg + Upload-Pool fallback leg), the feed-down behavior (both legs
      → Upload Pool; 503 when it's empty too), transport-only failover with verbatim node errors +
      10s timeout + 502 on exhaustion, last-good-slots retention, sends = Upload-Pool-only in add
      order + fail-closed 503, seed permanence, and the 60s feed / 15s health cadences.
- [ ] **Version & Network no longer appears on the landing**; the **Update & Deploy** view opens and
      contains the live version + per-seed reachability readout labeled as *seed-pair health*, plus
      a "deploy controls land in the next round" area (no fake buttons, no backend calls).
- [ ] Deep links work and nest: `/admin#connectors` and `/admin#connectors/stoachain` open the right
      views; Back walks stoachain → connectors → landing; legacy `#observation`/`#upload` land on
      the StoaChain page and `#version` lands on Update & Deploy.
- [ ] `node --check` passes; the full suite stays green; deployed to LittleBrother and visually
      verified live.

## Out of scope
- The on-box deploy backend (spool/systemd/blue-green/SSE) — **topic: update-deploy**, next.
- The sealed-creds vault backend — **topic: security-vault**, after.
- The two-tier embeddable verifier registry — **topic: embeddable-verifiers**, after.
- FIXING the rule-book's discovered quirks (healthz only reporting the seed pair; the hub feed's
  `refreshAfter` being parsed-but-ignored; stale code comments) — this topic *displays* the truth;
  the quirks go to the backlog.
- Any public-site change.
