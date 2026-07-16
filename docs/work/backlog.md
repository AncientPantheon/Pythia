# Backlog

- healthz only pings the two seed nodes, so its routing tri-state can contradict the pool actually serving reads (e.g. red while hub slots serve fine) — consider a pool-aware healthz (found 2026-07-16, apps/pythia/src/routes/healthz.ts:12-17 vs index.ts:179)
- hub feed `refreshAfter` is parsed but ignored — poll cadence hard-coded 60s, hub can't tune it (apps/pythia/src/hub/serviceClient.ts:133-137 vs pool/nodePool.ts:56)
- reads keep rotating the LAST-GOOD hub slot list indefinitely after a feed outage (no TTL) — de-listed nodes may keep receiving reads (pool/nodePool.ts:89-108)
- stale comments: index.ts:102-107 claims a third "seeds as last resort" read tier that doesn't exist; relay.ts:24-26 mentions a "later" tx-sender list that already exists
- ~340 lines of dead hub/txsender functions still defined in apps/pythia/public/app.js (superseded by admin.js) — delete, KEEP wireSubtabs (used by the chain module)
- verifier pubkey read (readApolloPublicKey.ts) is single-node — harden to N-of-M quorum/SPV before wiring the on-chain Link tx
