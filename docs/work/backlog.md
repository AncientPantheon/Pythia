# Backlog

- verifier pubkey read (readApolloPublicKey.ts) is single-node — harden to N-of-M quorum/SPV before wiring the on-chain Link tx
- 2026-07-30 apps/pythia/public/app.js:165-169 independently redeclares the Apollo codepoint classifiers (isStandardApollo/isSmartApollo) already canonicalized and exported from apps/pythia/src/routes/connectorVerify.ts (context: found during connector-auth-core review, out of scope — pre-existing frontend code, not touched by that topic; revisit when: touching app.js's Apollo-account handling again, or doing a broader dedup pass)

<!-- Cleared 2026-07-18 (cleanup sprint): pool-aware healthz, honor feed refreshAfter,
     stale hub-slot TTL, the two stale comments, and the ~396 lines of dead
     hub/txsender code in app.js are all done. -->
