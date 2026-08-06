# Pythia — Hub report-metering prerequisites — Design

## Problem
The AncientHub migration (`HANDOFF-ancienthub-automaton-migration.md`) needs Pythia to meter traffic the
Hub performs **directly against its own nodes** (it IS the node source) — without round trips. Pythia
today can only meter what flows through her gateway, and — critically — she has **no per-consumer READ
attribution** (the v2.7.30 `byConsumer` is transactions-only), so the Hub's reported reads have nowhere
to land. Four code gaps + one doc.

## Approach
Self-contained Pythia work, building on the v2.7.30 per-consumer transaction accounting.

1. **Shared `pondus()`.** Move the pure `pondus()` + `CLASS_BASE` from `apps/pythia/src/pyth/pondus.ts`
   into `@ancientpantheon/pythia-client` and re-export from `apps/pythia` (which imports the client from
   source via a TS path). The Hub imports it to compute identical read weights locally for its own XP.
   This is a real client API addition (the version bump is now justified). `round3` stays in apps/pythia.
2. **Per-consumer READ attribution.** Extend the ledger's `ConsumerTx` with `petitions` + `pondus`, and
   `recordRead(pondus)` → `recordRead(pondus, consumer?)`. The gateway meter's read branch (which already
   resolves the consumer to compute `keyed`) passes it through, so **every keyed read is attributed per
   consumer** — this is also the long-requested "petitions/pondus per API key" surface. `/pyth` already
   returns `byConsumer`, so it lights up automatically.
3. **Metering-report ingress `POST /pyth/report`.** Accepts a keyed, batched report of transactions
   `{ gasLimit, accepted, count? }` and reads `{ gasUsed, responseBytes, count? }`. Pythia **recomputes**
   pondus from the raw read inputs (so a reporter can't inflate weight), and records via
   `recordSend`/`recordRead` under the reporter's resolved consumer — into the **fleet ledger ONLY**
   (never the per-slot usage report, which would round-trip XP back to the Hub). Validated + bounded.
4. **Reporter-role gate.** An env-driven allow-list (`PYTHIA_REPORTERS`, mirror of `loadConsumerMap`) of
   consumer identifiers permitted to report. The route resolves the consumer from `x-pythia-key` and
   rejects (`403`) anyone not on the list — the ingress is never open.
5. **Frontend + doc.** The live pulse shows per-consumer **petitions/pondus** next to transactions (long
   apollo-account names shortened). Update `organs/06 §6` to the three-path metering model.

### Alternatives considered
- *Duplicate `pondus()` in the client instead of moving it* — rejected; two copies of the weight formula
  drift. One source, re-exported.
- *Reporter gate via a connector-store flag / admin UI* — rejected for now; an env allow-list is simpler,
  secret-driven (like `PYTHIA_API_KEYS`), and adequate. Can graduate later.
- *Trust reporter-supplied pondus* — rejected; recompute from raw `gasUsed`/`responseBytes` so a hostile
  report can't inflate the economy.

## Acceptance criteria
- [ ] `@ancientpantheon/pythia-client` exports `pondus()` + `CLASS_BASE`; `apps/pythia` re-exports them;
      all existing pondus/meter tests still pass.
- [ ] `recordRead(pondus, consumer?)` credits `byConsumer[consumer].petitions` (+1) and `.pondus`
      (+weight); aggregate `petitions`/`pondus` unchanged in behavior; no-consumer call leaves byConsumer
      untouched; persists + clears on nuke; legacy snapshots load.
- [ ] A keyed gateway read attributes petitions/pondus to its consumer in `/pyth` `byConsumer`
      (anonymous → `"direct"`).
- [ ] `POST /pyth/report` from an allow-listed reporter records batched transactions AND reads into the
      aggregate + `byConsumer[reporter]`, recomputing read pondus; a non-reporter key → `403`; malformed
      / oversized → `400`; it never feeds the per-slot usage report and never throws into the ledger.
- [ ] The live Activity pulse shows per-consumer petitions/pondus alongside transactions.
- [ ] `organs/06 §6` documents the three-path metering model.

## Out of scope
- The Hub side itself (its Codex/connector/reporter — separate handoff).
- Hub-earning economics changes; the per-slot report is untouched.
- On-chain per-consumer schema.
