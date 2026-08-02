# Handoff: Khronoton — event-driven server resolvers (scheduler-off, host-fired)

**To:** Khronoton agent (repo: `constructors/Khronoton`, package `@ancientpantheon/khronoton-core`,
currently `0.5.0`).
**From:** Pythia agent, on the operator's direct decision (2026-08-02).
**Consumer:** Pythia (`apps/pythia/khronoton-ui/KhronotonApp.tsx`) mounts khronoton-core's `<Builder>`
as-is and passes `serverResolverOptions`. Pythia cannot make this change from her own repo — the
`ServerResolverOption` type, the Builder, and the schedule/Execute UI all live in khronoton-core.

## The problem this solves

Khronoton cronotons all carry a real per-row schedule (`schedule_mode` + `schedule_config_json` →
`next_fire_at`), and the tick loop fires them off that schedule. That's correct for a genuinely
time-based cronoton (Pythia's `pyth-flush`, hourly at :58). But some server-resolver cronotons are
conceptually **event-driven**, not time-based: Pythia's `dual-link-activate` fires when a consumer's
two Apollo halves finish verifying — an event with no meaningful clock. Today it's forced to
masquerade as a scheduled cronoton that polls (its resolver returns empty accounts when nothing is
ready, and the pre-fire simulate guard postpones the empty fire — see
`packages/khronoton-core/src/server/resolvers.ts:280-303`, so no gas is burned, but the Builder
misleadingly shows a schedule editor for something that isn't schedule-driven).

The operator's design (which this handoff implements): **a server resolver declares whether it is
event-driven; selecting an event-driven resolver in the Builder automatically marks the cronoton
scheduler-off (host-fired), replacing the schedule UI with an honest "event-driven" indicator.** The
host application (Pythia) then fires such a cronoton on its own event via the already-existing
`executeNow` primitive — no new firing primitive is needed.

## What already exists (build on it, don't reinvent)

- **A scheduler-off persistence path:** `createCodexCronoton` computes
  `triggerOnly = input.externalFireable === true || runtimeArgKeys.length > 0` and, when true,
  persists `next_fire_at = NULL` (`packages/khronoton-core/src/server/store/cronoton.ts:126-133`;
  same in `resumeCodexCronoton` ~421-431 and the apply-at-next-fire edit ~343-355). The due-query
  `fetchDueCodexCronotons` then excludes any row with `next_fire_at IS NULL` (or non-null
  `runtime_arg_keys`) — `packages/khronoton-core/src/server/store/claim.ts:71-84`. So "scheduler
  never auto-fires this" already has a mechanism; event-driven is a THIRD reason to trigger it.
- **The programmatic firer:** `executeNow` (`packages/khronoton-core/src/handlers/execute.ts:188-212`)
  fires any non-paused, non-terminal committed row through `fireAndRecord` → `fireByServerResolver`,
  independent of `next_fire_at`. Confirmed it works for a scheduler-off server-resolver row — this is
  exactly the primitive the host calls on its event. No change needed to `executeNow` itself.
- **The resolver dropdown config:** `ServerResolverOption`
  (`packages/khronoton-core/src/provider/context.tsx:27-32`) — the per-option list a consumer passes
  via `serverResolverOptions`. This is where the event-driven tag rides.

## Requested changes (khronoton-core)

1. **Tag the resolver option.** Add an optional field to `ServerResolverOption`
   (`provider/context.tsx:27`):
   ```ts
   export interface ServerResolverOption {
     value: string;
     label: string;
     note?: string;
     /** When true, a cronoton using this resolver is EVENT-DRIVEN: the scheduler never
      *  auto-fires it (persisted scheduler-off); the host application fires it on its own
      *  trigger via `executeNow`. Selecting such a resolver in the Builder replaces the
      *  schedule UI with an event-driven notice. Omit/false = ordinary scheduled cronoton. */
     eventDriven?: boolean;
   }
   ```

2. **Auto-mark scheduler-off when an event-driven resolver is selected.** In the Builder, when the
   currently-selected `serverResolver` maps to an option with `eventDriven: true`, the cronoton must
   commit as scheduler-off — i.e. persist `next_fire_at = NULL` so `fetchDueCodexCronotons` never
   selects it. Reuse the existing trigger-only persistence path rather than a parallel one: extend
   the server-side `triggerOnly` computation (`store/cronoton.ts:126`) to also be true when the row's
   `server_resolver` is event-driven. Since the server doesn't itself know which resolver names are
   event-driven (that's UI config), the Builder must send the signal at commit time — your call on
   the exact mechanism, two clean options:
   - a new explicit boolean on the commit envelope (`CommitBody`, `handlers/cronoton.ts:70` +
     `58-59`) e.g. `eventDriven`/`noSchedule`, mapped from `builder-state.ts`'s
     state→commit (`~290-291`, mirroring how `externalFireable` already rides); OR
   - the Builder sets the existing scheduler-off signal. **Do NOT simply reuse `externalFireable`
     for this** unless you also want the external HMAC trigger endpoint enabled — an event-driven
     server-resolver cronoton is fired IN-PROCESS via `executeNow` by the host, and generally should
     NOT expose the public HMAC endpoint. A dedicated flag keeps "host-fired via executeNow" and
     "externally fired via HMAC" as distinct, independently-controllable states.

   **Important compatibility note:** `server_resolver` + `runtime_arg_keys` are mutually exclusive
   (`store/cronoton.ts:117-123` throws). Event-driven is NOT the runtime-arg mechanism — an
   event-driven cronoton has a `server_resolver` and NO runtime args. Make sure `server_resolver` +
   event-driven is explicitly ALLOWED (it's the whole point); only `server_resolver` +
   `runtime_arg_keys` stays forbidden.

3. **Show it honestly in the Builder UI.** Today the scheduler-off indicator (`isTriggerOnly`,
   `ui/builder-state.ts:174-177`; the Execute-tab schedule swap, `ui/builder/ExecuteTab.tsx:279-288`;
   the schedule summary line, `ExecuteTab.tsx:135,165-170`) keys ONLY on `runtime_arg_keys` being
   non-empty — it ignores both `externalFireable` and event-driven resolvers. So an event-driven
   cronoton would still wrongly render the full `ScheduleStep` editor. Broaden the scheduler-off
   detection to also be true when the selected resolver is event-driven (and, while you're in there,
   when `externalFireable` is set — that's a pre-existing UI/server disagreement worth closing in the
   same pass). When an event-driven resolver is selected:
   - Replace the `ScheduleStep` with an event-driven notice — distinct wording from the runtime-arg
     "Trigger-only (external / manual)" one, e.g. *"Event-driven — the host application fires this
     when its trigger condition is met; there is no schedule."*
   - The schedule summary row (`ExecuteTab.tsx`'s `scheduleLine`) reads e.g. `Event-driven
     (host-fired)`.
   - The resolver dropdown's side-note (`BuilderHeader.tsx` `useResolverOptions`, ~79-99) can surface
     the option's own `note`, so Pythia's own copy explains the trigger.

4. **`executeNow` — no change, just confirm + test.** It already fires scheduler-off server-resolver
   rows. Add/confirm a test that a committed event-driven (scheduler-off) server-resolver row (a) is
   never returned by `fetchDueCodexCronotons`, and (b) fires correctly through `executeNow`.

## Acceptance criteria

- [ ] `ServerResolverOption` carries an optional `eventDriven` flag.
- [ ] Selecting an event-driven resolver in the Builder commits the cronoton scheduler-off
      (`next_fire_at = NULL`); the tick loop never auto-fires it.
- [ ] The Builder shows an event-driven notice (not a schedule editor) for such a cronoton, and the
      schedule summary reflects "event-driven / host-fired" — no longer misleadingly showing a
      schedule.
- [ ] `server_resolver` + event-driven is allowed; `server_resolver` + `runtime_arg_keys` stays
      forbidden.
- [ ] `executeNow` fires a committed event-driven server-resolver row correctly (test).
- [ ] Ordinary (non-event-driven) resolver cronotons — e.g. `pyth-flush` — are UNCHANGED: they keep
      their schedule and the full ScheduleStep UI.
- [ ] Existing khronoton-core tests pass; new tests cover the event-driven commit path + UI swap.

## Consumer adoption on Pythia's side, once this ships (tracked here so it isn't lost)

Two follow-ups land in the Pythia repo after this is published (Pythia's deploy auto-bumps
`@ancientpantheon/khronoton-core@latest`, so the type/UI arrive on the next deploy):

1. **Tag the resolvers** in `apps/pythia/khronoton-ui/KhronotonApp.tsx`'s `SERVER_RESOLVER_OPTIONS`:
   `dual-link-activate` → `eventDriven: true`; `pyth-flush` → left scheduled (omit the flag).
2. **Fire on the event.** When Pythia's connector-auth verify flow (being built separately) marks a
   pair ready in `PendingActivationTracker`, fire the `dual-link-activate` cronoton via `executeNow`
   (in-process, by the committed cronoton's id — the verify flow will own resolving that id, e.g. by
   looking it up by `server_resolver = "dual-link-activate"`). This replaces the current
   poll-every-tick behavior with an instant, event-driven fire. This step is intentionally deferred
   to the verify-flow build — it's the natural home for the trigger.

Pantheonic-architecture docs (`organs/05-khronoton-engine-wire-in.md`) get the event-driven-resolver
pattern documented once this ships and Pythia adopts it — not before, to avoid documenting an
unbuilt feature as canonical.
