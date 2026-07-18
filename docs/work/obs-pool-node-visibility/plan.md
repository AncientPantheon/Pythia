# obs-pool-node-visibility — Plan

Four phases, one commit each; a single version bump in the final phase. Deploy is the
owner's (not part of this plan).

## Wave 1 — data layer (Phase 1 commit)
- [x] T1: Feed + pool retain the FULL advertised slot list — done when: `fetchNodes`
      returns, alongside the usable `slots` (unchanged, at-tip https, for reads), an
      `advertised` array = every slot with a non-empty `id` and an `https://` `url`,
      **preserving all extra fields** (so the hub's future `operatorPythXP`,
      `operatorPythLevel`, `slotRewardedRequests`, `slotStoicismEarned`, `earnedSince`
      pass through untouched); `NodePool` retains them and exposes
      `advertisedSlots(): AdvertisedSlot[]` (empty when the feed is off/down). Tests:
      `fetchNodes` keeps a not-at-tip slot in `advertised` but not in `slots`, and keeps
      unknown earnings fields; `NodePool.advertisedSlots()` reflects the last feed and is
      empty when unconfigured.
  - files: `apps/pythia/src/hub/serviceClient.ts`, `apps/pythia/src/hub/serviceClient.test.ts`, `apps/pythia/src/pool/nodePool.ts`, `apps/pythia/src/pool/nodePool.test.ts`
- [x] T2: Per-node reachability probe — done when: a new `probeNodes(urls, {fetchImpl?, timeoutMs?})`
      does `GET <url>/info` over HTTPS, 3s default timeout, cert-validated, returning per url
      `{ url, reachable, reason }` where `reason` is `null` on 2xx else one of
      `"refused" | "timeout" | "dns" | "cert" | "http <status>"`, derived from `err.name`
      (AbortError→timeout) and `err.cause.code` (ECONNREFUSED→refused, ENOTFOUND/EAI_AGAIN→dns,
      TLS cert codes→cert; unknown→"unreachable"); probes run in parallel. Tests (injected
      fetchImpl) cover: 2xx→reachable/null; non-2xx→`http <status>`; abort→timeout;
      ECONNREFUSED→refused; a TLS cert code→cert.
  - files: `apps/pythia/src/health/probeNodes.ts`, `apps/pythia/src/health/probeNodes.test.ts`

## Wave 2 — admin API (Phase 2 commit, depends on Wave 1)
- [x] T3: Ancient-gated `GET /admin/hub-nodes` + wiring — done when: `AdminExtras` gains
      `hubNodes?: { list(): Promise<EnrichedNode[]> }`; `index.ts` wires it to probe
      `nodePool.advertisedSlots()` via `probeNodes` and merge into `EnrichedNode`
      (`id,url,operator,atTip,height,reachable,reason` + any earnings fields passed through),
      **sorted** by `slotStoicismEarned` desc when present, else `slotRewardedRequests`, else
      `operatorPythXP`, else reachable-first then `id`; `routes.ts` registers
      `GET /admin/hub-nodes` behind `gate` returning the list. Tests (a
      `hubNodesRoutes.test.ts`): gated GET returns the injected enriched list; unauth→401;
      non-ancient→403. The merge+sort lives in a pure, unit-tested `enrichHubNodes`
      helper (not inlined in the route wiring).
  - files: `apps/pythia/src/hub/hubNodes.ts`, `apps/pythia/src/hub/hubNodes.test.ts`, `apps/pythia/src/index.ts`, `apps/pythia/src/admin/routes.ts`, `apps/pythia/src/admin/hubNodesRoutes.test.ts`

## Wave 3 — UI (Phase 3 commit, depends on Wave 2)
- [x] T4: Observation Pool node table — done when: the Observation Pool panel gains a
      `#hub-nodes` table fed by `GET /admin/hub-nodes`, one row per node: a reachability dot
      (green/red) with the `reason` as its title/label, IP (`id`), server URL, operator,
      at-tip, and earnings cells (operator PythXP/level + slot stoicism/rewarded-requests)
      shown when present else a muted "awaiting hub"; rows in the endpoint's order; refreshed
      when the panel opens and by the existing feed refresh control. Done when
      `node --check apps/pythia/public/admin.js` passes and a browser check shows the table
      rendering rows with red dots + reasons.
  - files: `apps/pythia/public/admin.js`, `apps/pythia/public/admin.html`, `apps/pythia/public/styles.css`
- [x] T5: De-conflate Update & Deploy — done when: the Update & Deploy view no longer renders
      the per-node reachability rows (the pool-aware `/healthz` pair), keeps the live
      **Version** readout and the **Deploy** controls, and the stale note ("reports only the
      two config seed nodes") is corrected to describe the live version only. Done when
      `node --check apps/pythia/public/admin.js` passes and the view shows Version + Deploy
      with no node rows.
  - files: `apps/pythia/public/admin.js`, `apps/pythia/public/admin.html`

## Wave 4 — release (Phase 4 commit, depends on Wave 3)
- [ ] T6: Version bump + changelog — done when: the four version files
      (`package.json`, `apps/pythia/package.json`, `packages/pythia-client/package.json`,
      `apps/pythia/src/version.ts`) read the next minor (`1.11.0`), `CHANGELOG.md` gains a top
      `## [1.11.0]` entry describing the Observation Pool node visibility, and
      `versionConsistency.test.ts` passes.
  - files: `package.json`, `apps/pythia/package.json`, `packages/pythia-client/package.json`, `apps/pythia/src/version.ts`, `CHANGELOG.md`
