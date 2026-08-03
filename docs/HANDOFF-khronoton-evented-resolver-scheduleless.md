# Handoff — khronoton-core: make an EVENTED server resolver disable scheduling (in the type + the Builder UI)

**Audience:** the `@ancientpantheon/khronoton-core` maintainer.
**Why:** A server resolver can be **event-driven** — its cronoton is fired by an in-process event, never
by a schedule (Pythia's `dual-link-activate` fires on a *link event*: a verified dual-Apollo pair). Today
khronoton-core has no notion of this. The mechanism to make a cronoton scheduleless already exists
(`externalFireable === true` → `next_fire_at = NULL` → the tick's `next_fire_at IS NOT NULL` due-query
skips it), but nothing ties it to the resolver. So the operator must *manually* mark a row external-
fireable, and the Builder UI still shows live schedule controls for an evented-resolver cronoton — which
is misleading: **picking an evented resolver should turn scheduling OFF, visibly and automatically.**

**Pythia has already enforced the BEHAVIOR consumer-side** (v2.7.19): it owns the set of evented
resolver names (`EVENTED_SERVER_RESOLVERS = { "dual-link-activate" }`) and, in its admin proxy, forces
`envelope.externalFireable = true` on COMMIT when the picked `serverResolver` is evented. So an
evented-resolver cronoton is always committed scheduleless. What Pythia CANNOT do is the two things that
belong in the package:

## Ask 1 — model "evented" on the resolver (so the package, not each consumer, knows)

Add an optional flag to the resolver registration:

```ts
export interface SingleTxResolver {
  kind: "single-tx";
  resolve: ...;
  settle: ...;
  /** This resolver is fired by an in-process EVENT, never by a schedule. A cronoton
   *  bound to it is scheduleless: commit/edit force externalFireable, next_fire_at
   *  stays NULL, and the Builder disables its schedule controls. */
  evented?: boolean;
}
```

Then in the store's `createCodexCronoton` / `editCodexCronoton`, derive it:

```ts
const registered = getServerResolver(input.serverResolver ?? "");
const evented = registered?.evented === true;
const triggerOnly = input.externalFireable === true || evented || runtimeArgKeys.length > 0;
```

So the package auto-forces scheduleless for an evented resolver regardless of the consumer — the
guarantee no longer depends on each consumer's proxy. (Pythia's proxy enforcement then becomes a
belt-and-suspenders no-op, which is fine.)

## Ask 2 — expose resolver metadata + make the Builder UI react

The Builder can't grey out scheduling for an evented resolver because it has no way to know which
resolvers are evented — there is **no resolvers-list/descriptor endpoint** today.

1. Add a read handler, e.g. `GET …/resolvers` → `[{ name, kind, evented }]` from the registry
   (`SERVER_RESOLVERS`). (Pythia will expose it under `/admin/khronoton/resolvers` via its existing
   catch-all proxy — it just needs the handler to exist.)
2. In the cronoton Builder UI (the bundled `@ancientpantheon/khronoton-core/ui`):
   - when the picked `serverResolver` is `evented`, **auto-check external-fireable and disable/hide the
     schedule-mode + schedule-config controls**, with a one-line note ("Event-driven — fired on its
     trigger, not a schedule");
   - when a non-evented (or no) resolver is picked, restore the schedule controls.
   This is the "so I can SEE scheduling turn off the moment I pick the evented resolver" the operator
   asked for — it can only be done in the bundled Builder, which lives in this package.

## Ask 3 — surface "evented / trigger-only" in the list + show "Evented" for next-fire

A scheduleless row has `next_fire_at = NULL`, but the client-facing list item
(`CodexCronotonListItem`) exposes **only** `nextFireAt: string | null` + `scheduleMode` — there is NO
`externalFireable`/`triggerOnly` field. So the admin list literally cannot tell an event-driven row
apart from one whose next fire simply isn't computed, and it renders the next-fire cell blank. It should
read **"Evented"** (or "On trigger — event-driven"), not blank and not a time.

1. Add `triggerOnly: boolean` (or `externalFireable: boolean`) to `CodexCronotonListItem` and populate
   it in the list mapper from `row.external_fireable === 1 || runtimeArgKeys.length > 0` (the same
   `triggerOnly` the store already computes at commit).
2. In the list/detail UI, when `triggerOnly` is true, render the **next-fire** column as **"Evented"**
   (or "On trigger") instead of a timestamp/blank — the row fires on its event, it has no next fire.

(Operator-reported: an evented transaction's "next fire" should say "evented", not a time.)

## Ask 4 — enforce one-resolver-one-cronoton at the store

A server-resolver name must bind **exactly one** cronoton: `findCodexCronotonIdByServerResolver` returns
the *most-recently-created* match, so a second cronoton on the same `server_resolver` silently shadows
the first and the wrong template fires. The store already has the finder (used as a provisioner
idempotency key) but does NOT enforce uniqueness on a manual commit — an operator can create two.

- In `createCodexCronoton`, when `input.serverResolver` is set, reject (or upsert) if
  `findCodexCronotonIdByServerResolver(input.serverResolver, { db })` already returns an id. A distinct
  error (e.g. `CodexCronotonValidationError("server resolver already bound to <id>")`) so the UI can
  show "delete the existing one first".

Pythia enforces this consumer-side today (a commit reusing a bound resolver → 409, in `admin.ts`), but
it belongs in the store so every consumer gets it.

## Acceptance

- A cronoton committed/edited with an `evented` server resolver is stored `next_fire_at = NULL`
  (scheduler skips it) even if the caller sends a schedule — enforced in the store, not just the consumer.
- `GET …/resolvers` lists registered resolvers with their `evented` flag.
- In the Builder, selecting an evented resolver disables the schedule controls (and auto-marks external-
  fireable); selecting a scheduled one restores them.
- The cronoton list's next-fire column shows **"Evented"** for a trigger-only/evented row (and the list
  item carries a `triggerOnly` flag so the UI can tell), not a blank or a timestamp.

## Reference (Pythia side, already shipped)

- `apps/pythia/src/automaton/khronoton/eventedResolvers.ts` — the evented-name set + `enforceEventedScheduleless`.
- `apps/pythia/src/automaton/khronoton/admin.ts` — forces `externalFireable` on commit for evented resolvers.
- `apps/pythia/src/automaton/khronoton/dualLinkActivateTrigger.ts` — the in-process event fire (why the
  cronoton is scheduleless in the first place).
- `docs/work/pythia-event-driven-activation/design.md`.
