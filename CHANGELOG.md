# Changelog

All notable changes to the Pythia repo/service are documented here, newest first. This
project follows [Semantic Versioning](https://semver.org). The version in the **top entry**
MUST equal the root `package.json`'s `version` (and, in turn, `packages/pythia-client/package.json`,
`apps/pythia/package.json`, and `apps/pythia/src/version.ts`) — this is enforced by
`apps/pythia/src/versionConsistency.test.ts`, so every version bump ships its own documentation.

Note: this is the **repo/service** changelog. The npm client's own change history lives in
[`packages/pythia-client/CHANGELOG.md`](packages/pythia-client/CHANGELOG.md).

## [2.7.28] — 2026-08-04

### Fixed — Activity tab showed stone = 0 despite a real flush (a gap day killed the on-chain read)

The on-chain Pyth ledger IS written (`UR_PythTotal` returns `last-day:3, petitions:66, pondus:11789`),
but the Activity tab showed all-zero stone + "nothing written on-chain yet". Root cause: `loadPythChain`
read the daily rows with the batch helper `URD_ListPythDaily(1, last-day)`, which maps a plain `read`
over EVERY day in the range and **throws on the first gap** — day 1 (the ledger epoch, never flushed)
has no row, so it errored `"No value found … for key: 1"`. That throw was in the same function as the
(successful) total read, so it discarded the total too → stone rendered 0. Now the total is read first
and always kept, and the daily chart window is read **per-day** (`UR_PythDay d`), skipping days with no
on-chain row — so a gap no longer wipes the stone totals. Verified against the live chain.
`apps/pythia/public/app.js`.

## [2.7.27] — 2026-08-04

### Fixed — keyed reads (ephemeral x-pythia-key) were miscounted as anon → nothing reached the hub

The connector protocol's `x-pythia-key` is an EPHEMERAL secret (minted on proof-of-ownership, TTL'd).
The gate middleware resolved it (via the ephemeral store) so gated access worked — but the METER's
`resolveConsumer` only checked the permanent `connectorStore` + env map, NEVER the ephemeral store. So
every real keyed read (Mnemosyne's, Pythia's own self-connector's, any `DualLinkConnector`'s) resolved
to `"direct"` (anon) at the meter, never earned, and never appeared in the hub's per-slot keyed usage —
Fleet Petitions/Pondus stayed 0 no matter how much keyed traffic flowed. `resolveConsumer` now resolves
the ephemeral store first (secret → the Apollo account that minted it), then permanent + env. AND a
KEYLESS gateway read now defaults to Pythia's own live self-connector key (when active) — "everything
not claimed by another consumer's key goes through Pythia's own key" — so Pythia's frontend display
reads count as hers instead of falling into the anon bucket. `apps/pythia/src/index.ts`.

## [2.7.26] — 2026-08-04

### Added — the Activity tab now reads the ON-CHAIN Pyth ledger (stone) alongside the local backlog (air)

Now that `A_Flush` writes the Pyth ledger on-chain, the landing's Activity tab reads it back and shows
two states in two colours: **STONE** — data written on-chain (read via `UR_PythTotal` + `URD_ListPythDaily`
through Pythia's own gateway), solid gold; and **AIR** — Pythia's local unflushed backlog (`/pyth`),
translucent cyan, awaiting the next flush. The four metric cards (petitions/pondus/transactions/gas) show
the on-chain total large with a "+ N in air" pending annotation; the daily chart stacks a gold stone bar
(on-chain, at the base) under a cyan air bar (backlog) per day; a legend + footnote ("written on-chain
through day N") explain the two. Each source degrades independently — chain slow/down shows air only,
local down shows stone only. A `coercePactNum` helper handles the chainweb `/local` value shapes
(`number` | `{int}` | `{decimal}` | string). `apps/pythia/public/{app.js,styles.css}`.

## [2.7.25] — 2026-08-04

### Fixed — the automaton's OWN dirty reads must NOT count as petitions (v2.7.24 over-reached)

The metering rule for `petitions`/`pondus` is: count reads Pythia **serves to a client** (any client —
her own frontend displaying chain data, OuronetUI, StoaExplorer, Mnemosyne, via the `/read` gateway),
and **NOT** Pythia's own internal dirty reads (the automaton's pre-fire safety-simulates, gas
calibration, etc.). v2.7.24's `meterChainRuntime` wrongly also did `dirtyRead → recordRead`, so Pythia's
own machinery reads started inflating petitions. Reverted: `dirtyRead` now passes through **unmetered**;
`meterChainRuntime` meters **only** `submit → recordSend` (the automaton's transactions — the correct,
still-wanted part). So petitions again reflect only client-served reads (as before v2.7.24), and
automaton TRANSACTIONS still count in the fleet ledger. Pantheon architecture `organs/06 §6` corrected
to state the two-counter rule precisely (served-reads-count / own-dirty-reads-don't; all sends count).

## [2.7.24] — 2026-08-04

### Fixed — Pythia's OWN automaton on-chain activity now counts in the Pyth ledger

Pythia is the Pantheon's on-chain meter, but her OWN automaton fires (Khronoton cronotons — `A_Link`,
`A_Flush`, …) submitted **straight to a node** through khronoton-core's chain runtime, **bypassing the
Pyth ledger entirely** — so the automaton's transactions never appeared (petitions ticked from gateway
reads, but TRANSACTIONS stuck at 0 even after real on-chain fires). The Khronoton chain runtime is now
wrapped (`meterChainRuntime`, `apps/pythia/src/automaton/khronoton/meteredRuntime.ts`): every `submit`
→ `recordSend` (a transaction, +gas reserved; a rejected/thrown submit → +failed/+wasted) and every
`dirtyRead` → `recordRead` (a petition). It's applied once at the shared context
(`getKhronotonContext`, wired from the composition root at engine start), so the tick loop, the
event-driven fire, AND admin Execute Now all meter through it. So Pythia's own automaton activity — and
anything else firing through her Khronoton — is metered like all other traffic, which is the entire
point of Pythia as the meter.

Note: this also counts the automaton's on-chain READS (safety simulates, gas calibration, and admin
Simulate previews) as petitions — every on-chain read through Pythia counts, by design.

## [2.7.23] — 2026-08-03

### Fixed — connector panel's status line froze on "Checking status…" after activation landed

The register panel's status line (`#reg-status`) was written once on the Link-button click ("…Checking
status…") and never re-touched, so after the autonomous activation actually landed on-chain the top
selection line correctly flipped to "API link active ✓ — Pythia fired A_LinkDualApiKey" while the bottom
line stayed frozen on "Checking status…" — the two disagreed. Now `#reg-status` is synced to the SAME
live activation phase on every poll (`setRegActivationStatus`, called from `updateActionBar`), so it
tracks `pending → activating → activated` and settles on "API link active — Pythia's automaton fired
A_LinkDualApiKey." The Link button just forces a re-check (no stuck message). `apps/pythia/public/app.js`.

_Milestone: the end-to-end verify → autonomous `A_Link` activation flow is confirmed working on-chain
(fires succeed; the pair shows linked). The remaining Khronoton detail-page "Schedule" label for an
evented cronoton is a bundled `@ancientpantheon/khronoton-core` Builder gap — tracked in the handoff._

## [2.7.22] — 2026-08-03

### Changed — adopt khronoton-core 0.7.0 + register `dual-link-activate` as `evented` (native scheduleless)

Pythia was pinned to `@ancientpantheon/khronoton-core@^0.4.2` while the deploy ran `@latest` (0.7.0) — so
the running Builder was newer than the version Pythia built/tested against. Bumped the pin to `^0.7.0`
(typecheck + full suite green: 608 pythia, 96 client) and adopted its native event-driven support:

- **`dual-link-activate` is now registered with `evented: true`.** khronoton-core 0.7.0 reads that flag to
  force the cronoton scheduleless on **commit AND edit** (`next_fire_at = NULL`), render it "Evented", and
  drive the Builder's schedule-control disabling — the native version of Pythia's earlier consumer-side
  stopgaps (which remain as harmless belt-and-suspenders + the boot repair for pre-0.7.0 rows).
- **Exposed the resolver roster** `GET /admin/khronoton/resolvers` (0.7.0's `{name,kind,evented}` registry)
  so the admin can see which server resolvers exist / are consumed.
- 0.7.0 also natively enforces one-resolver-one-cronoton in the store ("already bound — delete it first").

Remaining Khronoton-UI gaps (delete-with-warning — 0.7.0 still hard-blocks system deletes; the detail/edit
schedule rendering; a roster VIEW; engine-UI internal routing) are tracked in
`docs/HANDOFF-khronoton-evented-resolver-scheduleless.md` (status vs 0.7.0 noted at the top).

## [2.7.21] — 2026-08-03

### Fixed — migrate a pre-existing evented cronoton off its stale schedule + system-cronoton override delete

A `dual-link-activate` cronoton created before the scheduleless enforcement (≤ v2.7.18) still carried a
real `next_fire_at` and showed a misleading "next fire in N hours" — and couldn't be fixed: it's a
server-resolver ("system") row so khronoton-core refuses to delete it, and the edit handler can't flip
`externalFireable`. Pythia now **repairs its own evented system cronotons at engine boot**
(`repairEventedScheduleless`, `apps/pythia/src/automaton/khronoton/eventedScheduleRepair.ts`): a direct,
idempotent, guarded `UPDATE` forces `external_fireable = 1` + `next_fire_at = NULL` for any still-scheduled
evented row, so a redeploy clears the stale schedule (it becomes scheduleless — the tick skips it).

Also added an **override delete** escape hatch for a system cronoton (`POST /admin/khronoton/:id/force-delete`,
ancient-gated + confirm-required + audited; calls the store delete directly) — needed to clean up a
wrong/duplicate system cronoton, which the normal delete refuses. khronoton-core-side asks (editable
`externalFireable`, a confirm-gated force delete in the bundled Builder, the "Evented" next-fire display)
are in `docs/HANDOFF-khronoton-evented-resolver-scheduleless.md`.

## [2.7.20] — 2026-08-03

### Added — enforce one-resolver-one-cronoton (a server resolver binds exactly one cronoton)

A server-resolver name may bind only ONE cronoton: the fire lookup
(`findCodexCronotonIdByServerResolver`) keys off the name and returns the most-recently-created match, so
a second cronoton on the same resolver silently shadows the first (the wrong template fires). Pythia's
Khronoton admin now rejects a COMMIT that reuses an already-bound server resolver (`409` — delete the
existing one first), via `commitServerResolver` + a `findCodexCronotonIdByServerResolver` check in
`admin.ts`. The server-resolver rules (the `serverResolver` name IS the binding tag; one resolver ↔ one
cronoton; evented ⇒ scheduleless ⇒ "Evented" next-fire) are written down in the Pantheonic architecture
(`organs/05-khronoton-engine-wire-in.md §6`) and `docs/work/pythia-event-driven-activation/design.md`.
Store-level uniqueness enforcement + the "Evented" next-fire display are added to
`docs/HANDOFF-khronoton-evented-resolver-scheduleless.md` (khronoton-core).

## [2.7.19] — 2026-08-03

### Changed — picking an EVENT-DRIVEN server resolver turns scheduling off (enforced)

Follow-up to v2.7.18's event-driven activation: the system now KNOWS `dual-link-activate` is
event-driven and forces its cronoton scheduleless. Pythia owns the set of evented resolver names
(`EVENTED_SERVER_RESOLVERS`, `apps/pythia/src/automaton/khronoton/eventedResolvers.ts`) and, on a
cronoton COMMIT whose picked `serverResolver` is evented, forces `externalFireable = true` — so
khronoton-core stores `next_fire_at = NULL` and the scheduler's `next_fire_at IS NOT NULL` due-query
skips it. An evented-resolver cronoton can no longer be committed with a schedule (it can't auto-tick
and double-fire alongside the event). `pyth-flush` is explicitly NOT evented — it stays schedule-driven.
The live Builder-UI grey-out (schedule controls disabling the moment you pick an evented resolver) needs
the bundled khronoton-core Builder to read resolver metadata — written up in
`docs/HANDOFF-khronoton-evented-resolver-scheduleless.md`.

## [2.7.18] — 2026-08-03

### Fixed — dual-link activation is now TRULY event-driven (scheduleless)

Activation fired only on the `dual-link-activate` cronoton's Khronoton **schedule tick**, not on the
link event — so a verified pair sat until the schedule came due (and manual Fire is a one-off). What
was event-driven was only the *payload* (the resolver pulls the ready pair at fire time); the *trigger*
was left on the scheduler. Now the **link event itself** fires it: `PendingActivationTracker` gains an
`onPairReady` hook (invoked the instant a pair becomes fully proven) + a pure `hasReadyPair()`; a new
`dualLinkActivateTrigger` subscribes and fires `A_LinkDualApiKey` immediately, in-process, via the same
`executeNow` path (resolve → safety-simulate → submit → settle). A single-flight drain loop drains every
ready pair one-by-one, never fires a blank tx when the queue is empty, and stops on the first non-success
(the pair stays ready, retried on the next event). The cronoton is now **scheduleless** — it exists only
as the on-chain template; the event triggers it, no timer. Keyless preserved: the request path only
records the proof and never imports the automaton core. See `docs/work/pythia-event-driven-activation/`.

> Operator note: leave the `dual-link-activate` cronoton **scheduleless** (no recurring interval).
> Verifying a pair now fires it on the spot.

## [2.7.17] — 2026-08-03

Pythia's first end-to-end **automaton self-test**: verify a consumer's two Apollo halves against a
registered verifier, and Pythia **autonomously** activates their dual API link — plus a live liveness
indicator, deeper URL routing, and the verifier onboarding standard.

### Added — verify → autonomous activation, wired end-to-end

The browser connector-verify flow now bridges into the activation pipeline: once BOTH Apollo halves of
a pair prove ownership in a session, Pythia records the pair into its `pendingActivationTracker`, and
the `dual-link-activate` Khronoton cronoton fires `A_LinkDualApiKey` on its next tick — no operator
click, no key held (`A_LinkDualApiKey` is C_Link-optional/idempotent, so no prior on-chain link is
required). `GET /api/connectors/verify/status` now reports the live per-pair activation phase
(`pending` → `activating` → `activated`), derived from the tracker's authoritative per-pair state (a
pair is only `activated` once its on-chain activation is CONFIRMED via `commitActivation` — never
inferred from two independent per-account proofs, so a cross-pair the operator never verified together
can't be mis-reported). The register UI surfaces the phase live and the old "Link trigger not wired
yet" stub is replaced with the honest autonomous-activation state. See
`docs/work/pythia-automaton-activation/`.

### Added — automaton liveness "green check"

`GET /healthz` now carries an `automaton` block: `live` (the green check — Khronoton tick running AND
the activation pipeline wired AND Pythia's own dual API link online) plus the individual capability
flags and the count of registered verifiers. Each flag is a truthful runtime read, computed in the
composition root (the keyless request path never imports the automaton core). The landing (under the
chain medallions) and the admin header show a green/amber liveness badge, distinct from StoaChain node
reachability.

### Added — Tier-3 URL routing for admin sub-tabs

The admin StoaChain connector page's sub-tabs (Hub Feed / Observation Pool / Upload Pool / Routing
Rules) are now each their own addressable URL (`#connectors/stoachain/upload`), routed from the hash
like every other view — deep-linkable and Back-navigable, no longer flipped in memory behind a static
URL. Landing (Tier-1/Tier-2) and admin sidebar (Tier-1) already conformed. The Pantheonic architecture
routing standard (§3.7/§5.1) was extended to make Tier-3 addressability explicit.

### Docs

New Pantheonic architecture standard `identity/how-an-entity-becomes-a-pythia-verifier.md` — what an
entity must run and register to act as a Pythia verifier (Apollo key custody + `/apollo-verify` +
admin registration), naming Mnemosyne and OuronetUI as the first two supported verifier entities.

## [2.7.16] — 2026-08-03

### Fixed — Pyth Flush cronoton: encode entry numbers as explicit Pact values (`{int}`/`{decimal}`)

The Pyth Flush cronoton's simulate failed a Pact type check — the `entries` the `pyth-flush` resolver
sent didn't match the on-chain `object{…PythFlushEntry}` schema. Root cause: the resolver put RAW JS
numbers in the payload, but Kadena rejects a bare number in a command (`Type 'number' is not allowed …
Use { decimal: … } or { int: … }`), and `pondus` (the schema's only `decimal`) can't be represented as
a bare number at all — a whole value serializes as an integer and fails the `decimal` field. Because
the flush fire simulates before submitting, this blocked the flush entirely. The resolver now encodes
each entry's numbers into their Pact-value form (`{ int }` for `day` + the six integer counters,
`{ decimal }` for `pondus`; `iz-complete` stays a bool) — the admin Pyth Flush panel's own data
(`beginFlush`/`previewEntries`) is untouched. See `docs/work/pyth-flush-pact-value-encoding/design.md`.

## [2.7.15] — 2026-08-03

### Changed — Khronoton signing DELEGATES to Codex's resolver (no more hand-rolled key derivation)

The proper fix behind the v2.7.13 seedType stopgap: Pythia's Khronoton `KeyResolver`
(`keyResolver.ts`) no longer reimplements any key derivation. It now delegates entirely to Codex's
own canonical, seedType-complete headless resolver (`createHeadlessKadenaResolver` from
`@ancientpantheon/codex/ouronet` 0.8.0 — the Topic-1 enablement) — so koala / chainweaver /
eckowallet seeds all resolve through the ONE implementation Codex uses to record the keys, and the
whole class of "each consumer hand-rolls a partial resolver" bug is removed at the root. Pythia keeps
only the Kadena-only public-key filter (Apollo accounts never enter the signer list) and a thin
non-derivation ouro-account fallback; Codex's own wrong-key refusal guard propagates unchanged. See
`docs/work/khronoton-keyresolver-delegation/{design,review}.md`. (Mnemosyne carries the same latent
bug and gets the same delegation via handoff.) (This entry was cut as 2.7.14 but never published —
its CI caught an unhandled rejection in `listCodexPubs`: `loadSnapshot` throws synchronously on an
uninitialized codex, and doing that inside a `Promise.all` alongside the delegate's call orphaned the
delegate promise; the read is now sequential. 2.7.15 is that fix folded in.)

## [2.7.13] — 2026-08-03

### Fixed — Khronoton can now sign with a chainweaver/eckowallet seed (the simulate signing failure)

With v2.7.12 surfacing the real error, the Khronoton simulate failed with `seed "Pythia" derived a
different key at index 0 than the codex recorded — refusing to sign`. Root cause: the Khronoton
`KeyResolver`'s `fromSeedAccount` re-derived every seed with the koala SLIP-10 path only, ignoring
`seedType` — but Codex records a `chainweaver`/`eckowallet` seed's public key with Chainweaver's
BIP32-Ed25519 (WASM) derivation. So a chainweaver "Pythia" seed re-derived a different key and the
safety guard (correctly) refused to sign. `fromSeedAccount` is now seedType-aware — `koala` uses the
SLIP-10 path (unchanged), `chainweaver`/`eckowallet` use Chainweaver's derivation (matching how Codex
recorded it) — so the operator's existing seed signs with no re-setup. The wrong-key guard still
fires on a genuine mismatch. See `docs/work/khronoton-seedtype-derivation/design.md`.

## [2.7.12] — 2026-08-02

### Fixed — the Khronoton simulate's REAL error now shows in the UI (not "network error")

When a simulate fails server-side, khronoton-core's `withConfirm`→`mapStoreError` catches the throw
and RETURNS a structured 500 (the throw never escapes the handler), which the UI's fetch adapter can
only render as a generic "Simulation failed — network error." with the real reason invisible and
unlogged. v2.7.9 only caught throws that ESCAPE the handler, so it never saw this shape. Pythia's
`/admin/khronoton` dispatch now also unwraps a 5xx RETURNED by an execution route (simulate/execute/
trigger): it logs the real error server-side (`[khronoton] handler … → 500: …`) and re-emits it as
the 200 `{ ok:false, error }` shape the UI renders as "Simulation failed — <real error>". See
`docs/work/khronoton-admin-error-surfacing/design.md`.

## [2.7.11] — 2026-08-02

### Fixed — HOTFIX: the Khronoton admin page white-screened with any cronoton present

khronoton-core 0.6.0 (auto-adopted on deploy via `@latest`) crashes rendering the cronoton list:
`CronotonList` reads `row.pact_code` and calls `.replace` on it, but the list SQL projection never
returns `pact_code`, so the whole page threw "Cannot read properties of undefined (reading
'replace')" the moment the list had ≥1 cronoton. Pythia can't patch the package component, but it
owns the adapter — so `KhronotonApp` now wraps the adapter's `list()` to default `pact_code` to `""`
on every row (the preview reads "(empty)" instead of crashing; forward-compatible with a fixed
package via `?? ""`). This was NOT the v2.7.10 Back button (which is in the Builder branch, never
rendered on the list). Real fix handed off for khronoton-core 0.6.1
(`docs/HANDOFF-khronoton-cronotonlist-crash.md`). See
`docs/work/khronoton-cronotonlist-crash-workaround/design.md`.

## [2.7.10] — 2026-08-02

### Fixed — Khronoton Builder: added a Back button (editing a cronoton no longer strands you)

khronoton-core's `<Builder>` only leaves its screen via a successful Commit — it ships no cancel/back
of its own, so opening it to edit an existing cronoton left an admin with no way out but to save.
Pythia's `KhronotonApp` now renders a Back control above the Builder that returns to the cronoton's
detail (or the list, for a new one), discarding unsaved edits. Note: "Save" was never missing — it's
the package's Commit button on the Builder's Execute tab (the last tab). See
`docs/work/khronoton-builder-back-button/design.md`.

## [2.7.9] — 2026-08-02

### Fixed — Khronoton admin: a handler that throws now surfaces the REAL error, not "network error"

An operator wiring up the first live Khronoton cronoton hit "Simulation failed — network error." —
which is the Builder UI's generic label for a server-side failure, not a diagnosis. Pythia's
`/admin/khronoton` dispatch didn't wrap the handler call in a try/catch, so any exception (e.g. the
simulate's chain dirty-read failing, or a missing gas-payer key) fell through to an unstructured 500
that the UI could only render as an opaque transport error, with the real reason nowhere visible.
The dispatch now catches handler throws: logs the real error server-side (findable in `docker
logs`), returns it in the body at HTTP 200 as `{ ok:false, error }` for the execution routes
(simulate/execute/trigger) so the Builder shows "Simulation failed — <real error>", and a structured
500 `{ error }` for the rest. See `docs/work/khronoton-admin-error-surfacing/design.md`.

## [2.7.8] — 2026-08-02

### Fixed — Apollo keys STILL leaked into the Kadena signing-key picker (v2.7.7's metadata filter didn't hold)

v2.7.7 filtered the Khronoton signing-key list on Codex's `originCurve` metadata (`!== "apollo"`),
but real Codex-generated Apollo accounts in the field don't reliably carry that field set — so the
same Apollo keys (`9G.…`) still showed up in the `DALOS.GAS_PAYER` picker and the Signatures tab's
"Add Signer" list. Replaced the metadata check with a key-FORMAT check: a Kadena ed25519 public key
is always exactly 64 hex chars; an Apollo key is the `<len>.<xy>` format and can never match. This is
the actual on-chain requirement and is independent of any optional metadata. Applied at all three
`keyResolver.ts` call sites (both pickers + the signing path); regression test covers an
Apollo-format account with no `originCurve` field — the exact case the old filter missed. See
`docs/work/khronoton-resolver-picker-and-kadena-filter/design.md`.

## [2.7.7] — 2026-08-02

### Fixed — Khronoton admin: the Server Resolver dropdown had no options; the Kadena signing-key picker listed Apollo-curve keys

Investigating how to configure the on-chain `A_LinkDualApiKey` activation cronoton surfaced that its
already-registered `dual-link-activate` server resolver was genuinely un-selectable in the Builder —
the "Server Resolver" dropdown is populated from a `serverResolverOptions` prop Pythia's own
`KhronotonApp.tsx` never passed, so it always showed only "None (ordinary cronoton)." Both
already-registered resolvers (`pyth-flush`, `dual-link-activate`) are now selectable.

Also fixed, reported live: the `DALOS.GAS_PAYER` Kadena signing-key picker (and the signatures
picker) listed Apollo-curve Codex accounts alongside real Kadena keys — `keyResolver.ts` iterated
`ouroAccounts` with no filter on `originCurve`, even though Codex's own type already distinguishes
them. Now filtered to Kadena-curve accounts only, including the actual signing path (not just the
picker) as defense-in-depth. See
`docs/work/khronoton-resolver-picker-and-kadena-filter/design.md`, which also documents that no
Khronoton engine change is needed for event-style firing — the existing 30-second-tick
server-resolver poll-for-readiness pattern already covers it.

## [2.7.6] — 2026-08-02

### Changed — Self Connector panel: seconds-ticking countdown + a normal (not square) Link button

Reported live: the countdown text ("expires in 23h 59m") only visibly changed once a minute — the
operator's own bar for trusting the panel is genuinely live is watching the seconds tick down.
`formatCountdown` now always includes seconds, at every magnitude ("23h 58m 41s" / "42m 10s" /
"17s"). Also fixed: the Link button rendered squarish because `.conn-actions`'s flex row stretched
it to match its taller label+input sibling's full height. `align-items: flex-end` fixes it at the
shared rule (also benefits the other admin forms using the same pattern). See
`docs/work/self-connector-countdown-and-button/design.md`.

## [2.7.5] — 2026-08-02

### Fixed — Self Connector panel: layout collision + false "Not linked" after every redeploy

Reported live: the account address text visually overlapped the state chip (a long, unbreakable
162-char string with no `overflow`/`text-overflow` handling bled out past its shrunk container),
and both halves showed "Not linked" after a redeploy even though the dual-link-key was still
sealed and valid. Each half now renders in its own bordered "zone" (mirroring the Codex tab's own
account-box treatment) with the address ellipsis-truncated to fit its available width instead of
colliding with the chip. `SelfConnectorLoop.start()` now fires an immediate tick in addition to its
periodic one — a bare `setInterval` alone only fires its first tick after a full `intervalMs` (24h
for Pythia), so every fresh boot left an already-linked pair looking falsely "not-linked" for up to
a day. No re-linking needed — the next deploy self-heals on boot. See
`docs/work/self-connector-boot-tick-and-layout/design.md`.

## [2.7.4] — 2026-08-02

### Fixed — a Nuke could be silently undone by an in-flight blue-green deploy

The admin "Nuke" button (`PythLedger.nuke()`) could be silently reversed: the blue-green deploy
script starts the incoming container and lets it boot — loading the ledger file into its own
process memory — up to ~60s before Caddy cuts traffic over to it. A Nuke click landing in that
window hit the still-live outgoing container correctly, but the incoming container's own stale,
pre-nuke in-memory snapshot survived; its first `persist()` after cutover (a request, its 30s
timer, or its shutdown flush) silently overwrote the just-nuked file with the old data, resurrecting
it. `PythLedger` now tracks a generation counter bumped only by `nuke()`; every `persist()` first
checks the on-disk generation and self-heals (reloads) instead of writing over a newer reset it
doesn't know about yet. See `docs/work/pyth-ledger-nuke-race/design.md`.

## [2.7.3] — 2026-08-01

### Changed — Self Connector panel redesigned around a single consolidated ephemeral key

The admin Self Connector panel previously showed two independent-looking masked ephemeral secrets,
one per Apollo half — misleading, since `DualLinkConnector.status()` (the SDK class Pythia's own
self-connector already wraps) has always computed exactly ONE consolidated `secret`/`expiresAt`
(standard-preferred, smart-fallback) as the sole value ever used for real `x-pythia-key` gating.
`SelfConnectorLoop.status()` and `admin/routes.ts`'s `SelfConnectorStatus` now surface that single
top-level `maskedSecret`/`expiresAt` pair; each half's own view is reduced to just its linkage state
(`not-linked` / `pending` / `active`).

The panel itself is also rebuilt around the same `.deploy-card`/`.deploy-row`/`.deploy-chip` framed
visual language the Update & Deploy tab already uses, instead of its prior ad-hoc layout: a
diagnostic row per half (account + state chip, three visually distinct tones), and one ephemeral-key
card showing the masked secret alongside a new depleting timer bar (`.ttl-bar`/`.ttl-bar-fill`) and
countdown, shown only while a secret is actually active.

`websites/Pantheon/docs/pantheonic-architecture/organs/06-pythia-client-wire-in.md` is corrected to
describe this single-consolidated-secret pattern as the reference implementation, replacing its
earlier (incorrect) per-half guidance.

## [2.7.2] — 2026-08-01

### Fixed — pasting a dual-link-key into the Self Connector panel now checks the chain immediately

`POST /admin/self-connector/link` previously only saved the pasted key — nothing actually attempted
a connection until the next scheduled background tick, which for Pythia's own self-connector is up
to 24h away. An admin who pasted an already-active dual-link-key would see "Not linked" indefinitely
with no way to force an immediate check. `link()` now drives an immediate `tick()` right after
saving the key, so the panel reflects the real, current chain state within the same request instead
of a stale placeholder.

## [2.7.1] — 2026-08-01

### Fixed — flaky CI in `selfConnectorLoop.test.ts`'s real-timer tests

`v2.7.0`'s tag push failed both `publish.yml` and `image.yml` at the test gate (never reached the
actual publish/push step — confirmed neither artifact was published) — two different tests in
`SelfConnectorLoop — start()/stop()` each under-counted verify calls by exactly one, in two
separate CI runs. Root cause: those tests deliberately use real timers + a real Codex-backed sign
round trip (not stubbed), and `vi.waitFor`'s default 1000ms timeout didn't leave enough margin for
two genuine `smartDecrypt` KDF calls to complete on a slower/shared CI runner — a timing-budget gap,
not a logic bug (passed reliably, repeatedly, locally). Fixed by giving every `vi.waitFor` in that
describe block an explicit, generous `{ timeout: 5000 }`. No production code changed.

## [2.7.0] — 2026-08-01

### Changed — Pythia's self-connector signing now routes through her own Codex, never generates locally

Pythia no longer generates or holds her own Apollo private key material anywhere in her own code.
The admin generates + activates her Standard+Smart Apollo pair using Pythia's own embedded Codex
admin tab (proper seed-word/confirmation UX, unchanged — a pre-existing Codex feature). Ongoing
unattended signing is delegated to Codex's own `autoSignApolloChallenge`
(`@ancientpantheon/codex/ouronet`, bumped to `^0.7.0`), which decrypts the account's key material
from Codex's own already-sealed snapshot and signs — zero human interaction after initial Codex
setup, the same "re-read fresh every call, never cached" discipline Khronoton's Kadena signing
already uses.

- **Removed:** the Self Connector panel's "Generate" button and its `POST
  /admin/self-connector/generate` route — local key generation is gone entirely. Only the
  paste-a-dual-link-key field remains.
- **Removed:** the `self-apollo-standard`/`self-apollo-smart` sealed vault entries — Pythia's vault
  now holds only the pasted dual-link-key (public data); no private key material of her own.
- **Added:** `apps/pythia/src/automaton/codexApolloSigner.ts` — a Codex-backed `ApolloSigner`,
  validating a pasted dual-link-key's two halves are actually held by Codex's current snapshot
  before accepting it.
- **Changed:** `SelfConnectorLoop`'s own tick/refresh interval is now 24h (matching Pythia's own
  24h ephemeral-secret TTL, shipped in v2.6.0) — distinct from the published `DualLinkConnector`'s
  own 3h default, which every other consumer still uses unchanged.
- **Retired:** `SelfConnectorLoop`'s ability to prove ownership of a not-yet-linked pair (the
  pre-link ownership-proof flow feeding `PendingActivationTracker`) for Pythia's OWN identity
  specifically — she no longer has any account knowledge independent of an explicitly pasted key.
  The generic mechanism remains fully intact and tested for real external consumers.

See `docs/work/self-connector-codex-signing/{design,plan,review}.md` for the full rationale.

## [2.6.0] — 2026-08-01

### Added — Pythia's Self Connector gains a paste-in Link control, and a differentiated ephemeral-secret TTL

Pythia's own self-connector identity now composes the published `DualLinkConnector`
(`@ancientpantheon/pythia-client`) instead of a private, duplicate per-half tick loop — the same
mechanism any future consumer with an active dual-link-key uses. See
`docs/work/self-connector-dual-link/{design,plan}.md` for the full rationale.

- **Differentiated ephemeral-secret TTL.** `EphemeralKeyStore.issue()` now takes an optional TTL:
  6h by default (up from a flat 3h) for any verified consumer, 24h specifically for Pythia's own
  self-connector identity (`connectorAuth.ts`'s verify handler resolves which TTL to pass via a new
  `isSelfAccount` predicate checked against the composition root's own known accounts).
- **Self Connector admin panel gains a "Link" control.** An operator can paste an already-active
  on-chain dual-link-key; it's validated immediately against Pythia's own held accounts (rejecting
  a key that doesn't match), then stored and used to drive the same `DualLinkConnector` mechanism.
  Once active, the panel displays each half's ephemeral secret masked (`first7...last7`, via the
  newly-published `maskSecret`) plus a live countdown to expiry.
- **Internal consolidation.** `SelfConnectorLoop` now composes `DualLinkConnector` directly,
  self-deriving its own dual-link-key from its two known accounts and proving ownership toward
  on-chain activation the moment both halves exist — the pasted key is a confirmation/validation
  action, not a functional prerequisite for the underlying proof loop.

No breaking changes to any published contract — the reshaped `SelfConnectorStatus` admin type is
Pythia's own internal admin contract, not a published API.

## [2.5.0] — 2026-08-01

### Added — `@ancientpantheon/pythia-client` gains `splitDualLinkKey` + `DualLinkConnector`

A consumer that already has a dual-Apollo pair active on-chain (via Codex + either a raw `C_Link`
or Pythia's own browser Link-verify flow) has, in hand, exactly one thing worth pasting into a
settings field: the on-chain `dual-link-key` (`<standard-apollo>|<smart-apollo>`, the literal
`PYTHIA|T|DualLinks` table key, 325 chars). Splitting it and orchestrating the resulting two
`PythiaConnector`s into one usable, displayable thing existed only as private code inside the
Pythia service itself — every other consumer was left to reimplement this from scratch, which
already went wrong once when another consumer tried. See
`docs/work/pythia-client-dual-link-sdk/{design,plan}.md` for the full rationale.

- **`splitDualLinkKey(dualLinkKey)`** — validates and splits the composite key into its
  `standardApollo`/`smartApollo` halves, throwing `PythiaConnectorValidationError` with a message
  naming the specific problem (wrong length, missing/misplaced separator, a half not shaped like a
  valid Apollo account) rather than silently slicing malformed input.
- **`DualLinkConnector`** — a reusable class that, given a `dualLinkKey` plus one `ApolloSigner` per
  half, drives both halves' proof/refresh round trips on a schedule (with per-half error isolation)
  and reports one unified `status()`: both halves' individual state, plus a single live
  `secret`/`expiresAt` a consumer can use directly. Also exposes `keyProvider()` for direct
  `PythiaClientOptions.pythiaKey` wiring — the reusable primitive any consumer needs to actually USE
  an already-active on-chain dual-Apollo identity, without re-deriving this logic from scratch.

No removals, no breaking changes to any existing export.

## [2.4.3] — 2026-08-01

### Fixed — the actual on-box deploy failure: `Dockerfile`'s runtime stage silently dropped two organs

This is the real fix for the deploy failure reported after v2.4.2 shipped. Two distinct, stacked
bugs in `Dockerfile`'s runtime stage, both newly exposed by `apps/pythia` depending on
`@ancientpantheon/pythia-client` directly for the first time (v2.4.0) — confirmed by actually
building the image locally with Docker and running the container, not just re-checking CI:

1. **`packages/pythia-client` itself was never copied into the runtime stage.** npm workspaces
   hoist it to `node_modules/@ancientpantheon/pythia-client` as a *symlink* to
   `../../packages/pythia-client` — the runtime stage's `COPY .../node_modules` carried the symlink,
   but never its target, so it dangled and crashed the server at boot (`PythiaConnector` is a real
   class import, not just a type). Fixed: the runtime stage now also copies
   `packages/pythia-client/dist` + its `package.json`.
2. **The bigger one:** adding `pythia-client` as a new dependency shifted npm's hoisting decision
   for the *whole* tree — `@ancientpantheon/codex` and `@ancientpantheon/khronoton-core` now nest
   under `apps/pythia/node_modules/` instead of the monorepo root, and the runtime stage only ever
   copied the root `node_modules`. This is the documented "layout trap"
   (`docs/pantheonic-architecture/automaton/05` §1d) — npm can flip this on any install, unrelated
   to any code change. Fixed: the builder stage now guarantees `apps/pythia/node_modules` always
   exists (even empty), and the runtime stage copies it unconditionally alongside the root one, so
   the image is correct regardless of which way hoisting goes on a given build.

The build-time sanity probe (already present, catches this class of bug at build time instead of
crashing a live container mid-deploy) now actually resolves every `@ancientpantheon/*` subpath
`apps/pythia` imports — `pythia-client`, `codex/ouronet`, `khronoton-core/server`,
`khronoton-core/blockchain/stoachain` — run from `apps/pythia/`'s own directory (not `/app`), since
Node's module resolution only walks *up* from the importing file's location; probing from the
wrong directory silently skips exactly the nested-layout case this guard exists to catch (caught
this exact mistake on an earlier draft of the fix, before landing here).

Verified end-to-end locally: `docker build` succeeds, the container boots cleanly (Khronoton's tick
loop starts, no crash), and `GET /healthz` responds `200` — not just a green CI run.

## [2.4.2] — 2026-07-31

### Fixed — `SealedStore.rotateMasterKey` could leave a mixed-key vault on a failure mid-rotation

Master-key rotation re-seals every vault entry under the new key. The previous implementation
wrote-then-immediately-renamed each entry in one pass — if sealing/writing a LATER entry failed
(disk full, permission error, killed process), any EARLIER entries in that same call had already
been renamed into place under the new key, leaving the vault permanently split between two keys
with no way to fully unlock it under either one.

Rewritten as three phases, each safe to abort into the one before it: **PLAN** unseals every entry
under the old key (read-only — a failure touches nothing); **STAGE** seals each entry under the new
key into a `.tmp` sibling only (a failure here still leaves every entry readable under the old key,
unchanged); **COMMIT** renames every staged file into place only once every entry staged
successfully (pure filesystem renames, carrying none of STAGE's failure modes). A new regression
test sabotages one entry's staging step and confirms an earlier, already-staged entry's live file
is never renamed — the vault stays fully readable under the original key, not mixed.

No behavior change for the success path; `rotateMasterKey` is not yet wired into any admin route,
so this ships as hardening ahead of that wiring, not a fix to a reachable production bug.

## [2.4.1] — 2026-07-31

### Fixed — `image.yml`'s test gate ran before building `pythia-client`, breaking the ghcr image build

v2.4.0's own image build failed: `apps/pythia` now depends on `@ancientpantheon/pythia-client`
directly (the self-connector identity) for the first time, and that package's `exports` map points
at a `dist/` build artifact that doesn't exist until it's built. `.github/workflows/publish.yml`
already ran `typecheck && build && test` in that order (so it built `pythia-client` before testing
— confirmed: v2.4.0 published to npm successfully), but `.github/workflows/image.yml`'s gate ran a
bare `npm test` with nothing built first, so `apps/pythia`'s own test run failed to resolve the
package it now imports. Fixed by mirroring `publish.yml`'s gate: `npm run build` (which the root
script already scopes to `pythia-client` then `apps/pythia`, in that order) now runs before `npm
test` in `image.yml` too. No functional/behavioral change — CI-only fix, verified locally by
deleting `packages/pythia-client/dist/` and reproducing the exact failure, then confirming the
build step resolves it.

## [2.4.0] — 2026-07-31

### Added — Pythia becomes a complete automaton: her own dual-Apollo self-connector identity

Every Pantheon automaton is `Codex (keys+signing) + Pythia (reads) + Khronoton (scheduling) +
logic`. Pythia already had her own Khronoton engine and sealed key storage, but had never gone
through her own connector protocol (shipped in v2.3.0) — no dual-Apollo identity of her own, no
`PythiaConnector`, no dependency on `@ancientpantheon/pythia-client`. This release closes that gap,
with one deliberate carve-out: the actual data movement never leaves the process.

- **Her own dual-Apollo identity.** `apps/pythia/src/automaton/selfApollo.ts` — Pythia can now
  generate (idempotently, admin-triggered) two independent Apollo keypairs (a Standard `₱.` half
  and a Smart `Π.` half — two unrelated random keys, exactly like any other consumer's pair, never
  one key's two address encodings), sealed at rest in her existing vault, and sign challenges with
  them via the same `@ouronet/dalos-crypto` primitive her verify-side code already used read-only.
  This is new, deliberately scoped key-generation/signing capability inside `src/automaton/` — the
  one directory Pythia's own "keyless gateway" invariant scanner (`invariants/keylessScanner.ts`)
  has always exempted as the keyed sovereign half (Codex/Khronoton signing already lived there).
- **The in-process transport shortcut.** `apps/pythia/src/connectors/self/inProcessFetch.ts` —
  when Pythia talks to her OWN gateway, the request dispatches directly through her real Hono
  router in-process (no DNS/TLS/socket) instead of hairpinning out over the public internet to
  reach herself. The full connector-auth protocol logic still runs for real — only the literal
  network hop is skipped. Requires zero changes to the published `pythia-client` SDK; uses its
  existing `fetchImpl` injection seam.
- **The periodic self-connector loop.** `apps/pythia/src/automaton/selfConnectorLoop.ts` — drives
  both of her own accounts' challenge→sign→verify round trips on a schedule, feeding Topic 2's
  existing (unmodified) pairing/activation mechanism — proven end-to-end in this release's own
  integration test to pick up Pythia's own self-proofs with zero self-case branching anywhere in
  the connector-auth/activation code.
- **A third organ.** `@ancientpantheon/pythia-client` is now a real runtime dependency of
  `apps/pythia`, and her own Update & Deploy panel recognizes it as a third `CONSTRUCTORS` row
  (`admin/organVersions.ts`), alongside Codex and Khronoton — the trio
  `organs/05-khronoton-engine-wire-in.md`'s staged-integration gate was written for.
  `admin/routes.ts` + a small `admin.html`/`admin.js` panel expose the resulting status (public
  account strings + per-half state) so the operator can find what to manually register on-chain.
- **What stays manual, by design:** the actual on-chain `C_DeployApolloPythiaApiKey` (×2, 500 STOA
  each) and `C_LinkDualApiKey` transactions — real money, submitted by the operator, using the
  public account strings the new admin panel displays. Everything from proof onward is automatic.

Design: `docs/work/pythia-self-consumer/{design,plan,review}.md`.

## [2.3.0] — 2026-07-31

### Added — the connector protocol (Pythia's second sovereign automaton action)

Pythia can now autonomously activate a consumer's on-chain dual-Apollo API key —
the second of the two sovereign automaton actions (the first, the ledger flush, has
shipped since v2.1.0). Three topics, all part of this release:

- **`connector-auth-core`** — a new headless (non-browser-cookie) challenge/verify
  round trip (`POST /connectors/auth/challenge`, `POST /connectors/auth/verify`),
  parallel to the existing browser Link-verify flow. A verified caller whose Apollo
  account is part of an active on-chain `DualLink` receives a 3-hour ephemeral
  secret; real request gating now enforces it on `x-pythia-key` (a present-but-
  invalid/expired key is rejected with `401`; no key at all falls through to the
  existing unattributed access, unchanged). Backed by a new on-chain active-dual-link
  cache mirror (`DualLinkCache`), an ephemeral-secret TTL store, and a per-account
  nonce store — all reading their trust-anchor chain state from the operator's own
  Upload-Pool nodes, never the untrusted hub-fed pool.
- **`connector-activation-resolver`** — pairs the two independent per-half headless
  ownership proofs (one from each of a Standard/Smart Apollo pair) into one
  ready-to-activate `DualLink`, and a new Khronoton server resolver
  (`dual-link-activate`, mirroring the proven `pyth-flush` resolver's shape exactly)
  that signs and submits `A_LinkDualApiKey` on-chain — Pythia's own Codex key,
  Cronoton-gated, the same signing path already proven live for the ledger flush.
  Going live is gated purely on the `pythia-cronoton-keyset` on-chain re-pointing (a
  chain governance action, not code); the resolver fails cleanly (no crash) until
  then, per the Khronoton executor's "never throws" contract.
- **`pythia-client-connector-sdk`** — the actual integration surface: the published
  `@ancientpantheon/pythia-client` package gains `PythiaConnector`, the consumer-side
  orchestrator for the full challenge → sign → verify → store round trip against an
  injected `ApolloSigner` (the consumer's own signing capability) and `SecretStorage`
  (the consumer's own persistence). `PythiaClientOptions` gains `pythiaKey` (a static
  string or a live supplier — `connector.keyProvider()` — resolved fresh on every
  request) so a consumer automaton can wire a real, auto-refreshing ephemeral secret
  straight into `read`/`send`/`poll` as `x-pythia-key`. See
  `packages/pythia-client/CHANGELOG.md` for the SDK's own change entry.

Design: `docs/work/pythia-connector-protocol/design.md` (umbrella, covers Topic 1's
design directly), `docs/work/connector-auth-core/{plan,review}.md`,
`docs/work/connector-activation-resolver/{design,plan,review}.md`,
`docs/work/pythia-client-connector-sdk/{design,plan}.md`.

## [2.2.3] — 2026-07-23

### Changed
- **Deploy build time cut substantially.** Profiling the deploy log showed the docker build was
  **11m10s of an 11m20s deploy (98%)** — the blue-green machinery (source refresh, container
  start, health check, Caddy cutover, retiring the old container) costs ~10s total. The build
  cost was **not** a native compile as first assumed: `better-sqlite3` publishes a
  `linuxmusl-x64` prebuild for Node 22 and the log shows no `node-gyp` output at all. It is
  filesystem I/O over a ~1000-package tree on a slow disk, written repeatedly:
  - **`COPY --chown` replaces a trailing `chown -R pythia:pythia /app /data`** — the single most
    expensive step at a measured **168s**, because it walked and rewrote metadata for every file
    in `node_modules`. Ownership is now set as the files land, deleting that whole extra pass.
    (The non-root user is created *before* the copies so `--chown` can name it.)
- **Not done (yet):** an npm cache mount would also help — the version bump invalidates the
  `npm ci` layer every release, so npm re-downloads ~1000 packages each time — but it requires
  BuildKit, and this host has **no buildx plugin** (the deployer has always fallen back to the
  legacy builder, which cannot parse `--mount=type=cache`). The Dockerfile stays
  legacy-compatible; revisit once `docker-buildx-plugin` is installed on the box.

## [2.2.2] — 2026-07-23

### Fixed
- **The constructor `@latest` bump no longer aborts the deploy.** 2.2.1 ran `npm install` on the
  host to adopt newly published organs — but this box is deliberately minimal (Docker only, no
  Node/npm), so every deploy died at step 1/5 with `npm: command not found`. It now runs npm in a
  throwaway `node:22-alpine` container against the checkout, and the bump is **best-effort**: a
  registry hiccup logs a warning and the deploy continues with the pins committed on main, rather
  than failing an otherwise-good build. (The failure was safe — it aborted before touching any
  container, so the live site was never at risk.)
- **An unreadable installed version no longer claims to be current.** A constructor whose version
  could not be read rendered as `vunknown · up to date`, which looks healthy while saying nothing
  about what is actually running. It now reads `installed version unreadable`, with npm's latest
  for context.

## [2.2.1] — 2026-07-22

### Fixed
- **A deploy can now actually adopt a newly published constructor.** The image builds with
  `npm ci`, which installs the lockfile *exactly*, and the deployer never bumped the pins —
  so no deploy could ever pick up a new Codex/Khronoton release, however long it ran, no
  matter that the panel advertised one as available. The deployer now bumps
  `@ancientpantheon/codex@latest` + `@ancientpantheon/khronoton-core@latest` before building
  (the model the Mnemosyne deployer already used), so Deploy adopts published organs.
- **Organ versions no longer read as `unknown` when npm nests them.** The installed-version
  reader walked up only from `process.cwd()`, which in the container is the workspace root
  (`/app`) — so a dependency npm left nested at `/app/apps/pythia/node_modules/...` instead
  of hoisting was never found. It now walks up from the module's own location first, which
  covers both layouts.

### Added
- **Deploy works on localhost.** A dev box has no docker/reverse-proxy, so Deploy used to be
  a dead, disabled button. In `dev` mode it now pulls the constructors at `@latest` and
  rebuilds, writing the same log/status contract as the host deployer — so the whole progress
  display (heartbeat, pacman, timer, auto-reload) drives it locally too.

### Changed
- Constructor pins bumped to **Codex 0.6.1** and **Khronoton 0.4.2**.
- **Declared `@ouronet/ouronet-core` explicitly.** Codex 0.6.1 renamed its required peers
  (`@stoachain/*` → `@ouronet/*`); this one was satisfied only by npm auto-peer-install, which
  breaks under pnpm-strict or `--legacy-peer-deps`. Now declared, per the organ dependency
  contract (`organs/ORGAN-DEPENDENCY-CONTRACT.md` R1).

## [2.2.0] — 2026-07-21

### Added
- **Always-moving deploy progress** (the canonical rule: something must always be moving
  while a deploy runs, so a slow-but-working deploy never reads as stuck):
  - The host deployer now **heartbeats a log line every ~6s** for the whole run, so the
    streamed terminal always grows even during a long silent `docker build` step. If the
    heartbeat stops, the deployer itself has died.
  - The **Update & Deploy** panel gained a live progress display: a ticking elapsed timer,
    the current build **Step N/M**, and a **pacman heartbeat** animation. On completion it
    shows the total time (*"finished in Xm YYs"*); a >20s output silence flags a stalled
    host in red.
  - The panel **auto-attaches** to a deploy already in flight — even one this browser didn't
    trigger (another operator, or an agent via the spool) — via a new `active` field on the
    deploy-status endpoint. See `docs/work/deploy-progress/canonical-rule.md` (to be promoted
    to the Pantheonic Architecture deploy standard).
  - On a successful deploy the panel **auto-reloads the page** (short countdown) so the
    operator lands on the freshly-deployed version without a manual refresh (as Mnemosyne does).

## [2.1.0] — 2026-07-21

### Fixed
- **Deploy confirm no longer shows on its own.** The inline confirm's `display:flex` class
  was defeating its `hidden` attribute, so the Yes/Cancel card was always visible. Added the
  `[hidden]` override (as the rest of the admin does) so it appears only when Deploy is
  clicked — now a bit below the button (kept visible) instead of flush against it.

### Added
- **On-chain Pyth-ledger flush (Khronoton drain model).** Pythia can now feed her local
  per-UTC-day ledger to the on-chain `PYTHIA|A_Flush(entries)` transaction via a Khronoton
  cronoton, with no sealed-day tracking:
  - The ledger builds flush entries in the exact Pact `PythFlushEntry` shape — integer
    `day` ordinal (epoch `2026-07-21`), `iz-complete` derived (past day = sealed, today =
    open), kebab-case keys, `pondus` ≤3dp — oldest-first, capped at 1000/tx.
  - A **`pyth-flush` single-tx server resolver** fills the cronoton's `entries` payload at
    fire time and **drains** the sent buckets only on confirmed on-chain success (a failed
    or unfired flush retries next tick; traffic arriving mid-flush is preserved).
  - The **ledger epoch (day-1 anchor)** is read once from chain
    (`PYTHIA.UR_PythLedgerEpochStart`) at boot and cached on `/data` — the day ordinals use
    the on-chain truth, not a hardcoded constant (which remains the fallback until the read
    lands / if the read gateway is down).
  - A new **Pyth Flush** admin panel is a live monitor of the per-UTC-day backlog — the
    exact `entries[]` the next `A_Flush` would send (day ordinal, date, open/complete
    status, the six counters), plus the resolved epoch + its source (read from chain /
    cached / hardcoded default). Auto-refreshes every 10s while open, and warns when more
    than two day-buckets are unflushed (a stuck daily flush).
  - Operators wire the flush as a cronoton in the Khronoton console — see
    `docs/work/pyth-flush/design.md` and the cronoton setup guide.

## [2.0.4] — 2026-07-21

### Changed
- **Deploy confirmation is now inline, not a popup** (matches Mnemosyne). Clicking Deploy
  swaps the button for a "Yes, deploy / Cancel" confirm row in the same card; Cancel swaps
  back. No modal dialog.
- **Breathing room above the Deploy button** — the on-box deploy controls gained top spacing
  so the button no longer crowds the note above it.
- **Readable content links.** Links inside admin notes (e.g. the "Blockchain Connectors →
  StoaChain → Observation Pool" cross-reference) used the browser-default violet, unreadable
  on the dark panel; they now render in the gold accent with an underline.

## [2.0.3] — 2026-07-21

### Changed
- **Codex top-bar Download / Load buttons now stack vertically** (one below the other),
  matching Mnemosyne's codex layout, instead of sitting side-by-side.

## [2.0.2] — 2026-07-21

### Changed
- **Update & Deploy now matches the canonical Pantheon deploy window (Mnemosyne-style).**
  The whole view lives in one framed card instead of free-floating text: the version
  readout is grouped into **Pythia** and **Constructors**, each as a framed row showing
  the name + package and installed → available version chips (an update chip when newer,
  "up to date" when equal); the on-box deploy status, Deploy button, and the streaming
  build terminal sit in the same card. The version payload now carries each organ's npm
  package name so the rows can show `Codex · @ancientpantheon/codex`.

## [2.0.1] — 2026-07-21

### Fixed
- **Codex UI, aligned to the canonical Pantheon codex layout + no more silent unlock
  failures.** Three fixes to the admin Codex console:
  - Removed the redundant **Lock/Unlock** button from the top bar — the single lock/unlock
    control now lives only in the CODEXID identity row (matching Mnemosyne / the codex spec:
    Download + Load up top, lock/unlock in the identity row).
  - Fixed the **auto-lock debouncer positioning** — the top-bar actions and the debouncer
    now sit centered on one row and no longer wrap/misalign.
  - When the admin session has lapsed, the Codex now shows a clear **"session expired —
    reload and sign in again"** banner instead of silently staying Locked with a dead unlock
    button, and it no longer retries the unlock endpoint in a loop. With a valid session the
    codex auto-unlocks as before.

## [2.0.0] — 2026-07-20

**Pythia becomes a sovereign Pantheonic Automaton.** She keeps her keyless read/relay
face for clients — now named **Pythiaeyes** — and gains a keyed sovereign core that can
hold keys and sign her own on-chain transactions. The client-facing guarantee is
unchanged: Pythiaeyes never holds a key and never signs.

### Added
- **Codex organ.** Pythia's own sealed key vault with the full Mnemosyne Codex UI baked
  in (add keys to an empty codex, load an existing codex, download it re-encrypted under
  a chosen password, reload it re-sealed under the key Pythia holds). Server-custody
  adapter under `/admin/codex`; the React console mounts in the admin (Codex tile).
- **Khronoton organ.** Scheduled autonomous signing. The tick engine boots dormant with
  the app (better-sqlite3 cronoton store, the StoaChain runtime, and a codex-backed key
  resolver that unseals the exact signing key per pubkey and refuses the wrong/unknown
  key). Ancient-gated admin API under `/admin/khronoton` plus the full Cronoton console
  (list / detail / builder) in the admin (Khronoton tile) — set the cronotons Pythia
  fires on-chain, with the gas paid by the Ouronet gas station (she signs only).
- **Sealed-credential store** upgraded to a directory of per-entry `<name>.sealed`
  entries, sealing the hub HMAC secret AND Pythia's operator codex (password + backup)
  at rest under a single `PYTHIA_MASTER_KEY` — the same libsodium scheme as the hub and
  Mnemosyne. Auto-unlock at boot; locked (reads only, no signing) when the key is absent.
- **Multi-version readout.** The Update & Deploy panel now shows the entity plus each
  automaton organ — Pythia, Codex, Khronoton — installed→available with per-organ update
  badges (Mnemosyne-style).

### Changed
- **The keyless invariant is reframed, not dropped.** It now guarantees the **Pythiaeyes
  constructor face** (the client request path) holds no keys, enforced by the keyless
  scanner PLUS a hard isolation boundary: no module outside `src/automaton/` may import
  the keyed core (`scanForAutomatonImports`). A client request can never reach the Codex
  or a signature.
- **Container.** The image now builds the native `better-sqlite3` addon and both React
  admin islands; the sealed store and cronoton store live on the `/data` volume
  (`PYTHIA_VAULT_DIR=/data/vault`, `PYTHIA_KHRONOTON_DIR=/data/khronoton`), replacing the
  single-file `VAULT_FILE`.

### Operator notes (cutover)
- Generate a base64 32-byte `PYTHIA_MASTER_KEY` on the box and supply it to the
  container; without it Pythia serves reads but cannot unseal the vault or sign.
- The vault moved from a single JSON file to a directory store, so the hub HMAC secret
  must be re-pasted once after the cutover (Security panel).

## [1.13.1] — 2026-07-19

### Fixed
- **The Pyth ledger now survives redeploys.** `PYTH_LEDGER_FILE` was never set, so the
  Activity/Earnings ledger (Petitions/Pondus + Transactions/Gas) defaulted to the ephemeral
  container filesystem — every deploy or restart started a fresh container with an empty
  ledger, so accumulated reads vanished. The Dockerfile now bakes
  `PYTH_LEDGER_FILE=/data/pyth-ledger.json`, co-located with the other `/data` stores, so
  the counts persist across deploys. (Unrelated to the 1.13.0 deep-link change.)

## [1.13.0] — 2026-07-19

### Changed
- **Every landing view now has its own URL** (Pantheonic Architecture §3.7). The landing's
  Tier-1 sections and Tier-2 sub-views are addressable, deep-linkable, and back-navigable —
  `#chains`, `#activity/arweave`, `#connectors/register`, etc. The URL hash is the source of
  truth: the shown view is derived from it on load and on every `hashchange` (Back/forward
  and programmatic nav), instead of flipping panels in memory behind a single opaque URL. A
  bare section (`#connectors`) resolves deterministically to its first sub-view, so the same
  URL always renders the same view. (The admin already followed this model.)

## [1.12.2] — 2026-07-19

### Changed
- **Anonymous reads now count in Pythia's own ledger.** Every served read/poll — including
  anonymous (non-Pythia-keyed) ones — now moves Pythia's **Petitions + Pondus** (her own
  service volume, observational). The **minting path is unchanged**: only *keyed* reads
  served by *hub* nodes contribute earning Pondus to the per-slot hub report, so an
  anonymous read counts for Pythia but earns no operator any PythXP. Sends remain
  Transactions/Gas and never mint. (Previously anonymous reads were served but not metered
  at all, so a plain dirty read left the ledger at zero.)

## [1.12.1] — 2026-07-18

### Changed
- **StoaChain connectors: a dedicated "Hub Feed" tab.** The hub base URL + HMAC secret
  form now lives in its own first sub-tab (**Hub Feed · Observation Pool · Upload Pool ·
  Routing Rules**), so connecting to the hub is separated from observing the fleet.
  Observation Pool is now purely the hub-fleet node table.

## [1.12.0] — 2026-07-18

### Added
- **Update & Deploy shows installed → available.** The panel now reads the version
  running vs. the version a deploy would build (the repo's `main`, read from public
  GitHub), Mnemosyne-style: `Installed v1.11.0 → v1.12.0 · update available`, or "up to
  date" when equal, or "latest: unreachable" if the repo can't be read. Served by a new
  ancient-gated `GET /admin/version-info`.

### Fixed
- **Observation Pool node row no longer overflows on a long operator.** The hub is
  currently sending a garbled/over-long `operator` value; the row now truncates it (with
  the full value on hover) instead of letting it overflow and overlap the node's IP.

## [1.11.0] — 2026-07-18

### Added
- **Observation Pool now shows the whole hub fleet.** The admin Observation Pool renders
  one row per advertised hub node — IP, server URL, operator, at-tip — each with a
  **reachability dot probed from Pythia's own vantage** (`GET <url>/info`, HTTPS, 3s,
  cert-validated) and, when red, the **reason** (`refused` / `timeout` / `dns` / `cert` /
  `http <status>`) so a dead node is diagnosable at a glance instead of an opaque red dot.
  Per-node **earnings** (operator PythXP/level + the slot's stoicism/rewarded-requests)
  render when the hub returns them and degrade to "awaiting hub" until it does. Served by a
  new ancient-gated `GET /admin/hub-nodes`; the feed now retains the full advertised slot
  list (not just a count).

### Changed
- **Update & Deploy is version + deploy only.** The per-node reachability rows moved to the
  Observation Pool (their proper home); Update & Deploy keeps the live Version readout and
  the Deploy controls, and its stale "reports only the two config seed nodes" note is
  corrected.

## [1.10.1] — 2026-07-18

### Fixed
- **Sealed vault now persists across deploys.** `VAULT_FILE` was unset, so the vault
  defaulted to the ephemeral container filesystem (`/app/pythia-vault.json`) while
  settings live on the `/data` volume — the boot migration stripped the plaintext hub
  secret from persistent settings and sealed it into a file that a redeploy would wipe.
  The Dockerfile now bakes `VAULT_FILE=/data/vault.json`, co-located with
  `SETTINGS_FILE`, so the sealed credential survives redeploys.

## [1.10.0] — 2026-07-18

### Added
- **Sealed credential vault.** The bearer credentials Pythia must *use* — chiefly the
  hub M2M HMAC secret — are now **encrypted at rest** (AES-256-GCM) under a master key
  taken from the deploy env (`PYTHIA_MASTER_KEY`), which lives off the data volume. A
  leaked volume/backup no longer exposes the secret; you also need the master key. The
  key auto-unlocks the vault on boot, so the hub feed keeps signing across restarts with
  no human present — the admin login gates *management*, not decryption. Any pre-existing
  plaintext secret is migrated into the vault and stripped on first load. With no master
  key set (dev), the store transparently keeps the old plaintext behavior, surfaced in
  the UI so it is never silent. Master-key rotation is a tested `rotateMasterKey` op +
  a documented procedure ([`docs/OPS-master-key.md`](docs/OPS-master-key.md)) — never a
  browser field.
- **"Security" admin tab** (ancient-gated): the vault status (Sealed / Plaintext-fallback
  / Locked), the master-key fingerprint, the sealed credentials listed by name (masked —
  never the value), and a themed-confirm **Clear vault** decommission action.

## [1.9.1] — 2026-07-18

### Changed
- **Pool robustness.** `/healthz` is now **pool-aware** — it reports the nodes actually
  serving reads (the live hub pair or the Upload Pool), not just the two config seed
  nodes, so its status can't contradict the real read path. The node pool now **honors
  the hub feed's `refreshAfter`** (a self-rescheduling poll, clamped 15s–5m) instead of
  a fixed 60s cadence, and **drops stale hub slots after a TTL** (3m) so a de-listed
  node stops receiving reads after an outage (reads fall back to the Upload Pool).
- **In-theme confirmations everywhere.** Every destructive/confirm action (Deploy,
  Nuke the Pyth ledger, remove verifier/upload-pool node) now uses the site's themed
  modal instead of the browser's `window.confirm`.

### Removed
- ~396 lines of dead hub/txsender code in the landing's `app.js` (superseded by the
  `/admin` dashboard); two stale code comments corrected.

## [1.9.0] — 2026-07-18

### Added
- **Hub usage reporting (the minting feed).** Pythia now reports her served reads to
  the AncientHub so node operators actually mint — the outbound half of the Pyth
  economy. Every ~60s she drains a **per-slot** window (`keyedRequests` /
  `anonRequests` / `ok` + `keyedPondus`, attributed to each hub node by slot id) and
  POSTs a signed report to `POST /api/pythia/usage/`. Only **keyed reads served by
  hub-pool nodes** earn; Upload-Pool/seed reads, sends, and polls never do.
  - **Execution-accurate weight.** The report carries `keyedPondus` (PONDUS_V1) +
    `pondusVersion: 1`, so heavier reads earn more, from row one.
  - **Money-path safety.** Windows are contiguous, non-overlapping, and immutable; a
    failed POST is retried unchanged (idempotent, first-write-wins on the hub); empty
    windows are skipped.
  - **Honours the Report-to-hub toggle** (StoaChain Earnings): OFF keeps counting
    locally but reports nothing — that span never mints — while Pythia's own fleet
    ledger keeps accruing.

### Changed
- `dial()` gains an optional `onServed(node)` hook (surgical; the 15 callers are
  byte-identical without it) so a read can be attributed to the hub slot that served
  it; `NodePool` now exposes `operatorForSlot(id)`.

## [1.8.0] — 2026-07-18

### Added
- **Pyth-economy metering (keyless).** Pythia now meters the service she provides into a fleet-wide
  ledger: **Petitions + Pondus** for keyed reads (`PONDUS_V1 = classBase + √gas/2 + bytes/4096`,
  applied per request) and **Transactions + Gas** for relayed sends. It is **execution-level** — a
  self-polling tracker resolves each relayed tx to its mined outcome (a success counts its *actual*
  gas; a revert counts as a failed tx with its *actual* wasted gas; a tx that never mines times out
  as failed). The ledger keeps per-day deltas ready for a future on-chain daily flush.
- **Activity is now the Pyth economy.** The StoaChain Activity view shows **Petitions · Pondus** and
  **Transactions · Gas relayed** (plus Failed / Wasted) with a daily-petitions chart, served by a new
  keyless `GET /pyth`. The old Errors card and Poll metric are gone; Activity is per-chain
  (StoaChain / Arweave) in the header tier-2.
- **"StoaChain Earnings" admin tab** (ancient-gated): the six ledger totals, a confirm-guarded
  **Nuke the ledger** reset, and a **Report-to-hub** on/off switch.

### Changed
- **Landing reshaped into a fixed-size single-screen page.** A three-level sticky Pantheonic Header
  (full-chrome-width separator; Tier-1 sections + Tier-2 sub-navigation both live only in the header),
  a full-height Pythia portrait with a collapse toggle, and a work-area that fills the page and scrolls
  internally. Widened to 1760px. (Codified in the Pantheonic Architecture library, `design/` v1.2.)

### Notes
- Outbound **hub usage reporting** (Pythia → hub, which drives B.UNA / Stoicism minting) lands in the
  next release; the Report-to-hub toggle already ships as the setting it will honour.

## [1.7.0] — 2026-07-15

### Changed
- **Version unified across the workspace.** Root `package.json`, `packages/pythia-client/package.json`,
  `apps/pythia/package.json`, and `apps/pythia/src/version.ts` now all carry the same version. The
  client jumps `1.1.0 → 1.7.0` to align with the service (previously drifted, `1.1.0` vs `1.6.0`).

### Added
- **GHCR container image publish** (`.github/workflows/image.yml`) — a `v*` tag now also builds and
  pushes `ghcr.io/ancientpantheon/pythia:<semver>` + `:latest`, alongside the existing npm publish of
  `@ancientpantheon/pythia-client`, from the same tag.
- **Versioning gate** — a new `apps/pythia/src/versionConsistency.test.ts` asserts the four version-bearing
  files agree with each other and with this changelog's newest `## [x.y.z]` entry, and this root
  `CHANGELOG.md` itself, so a version bump can no longer merge undocumented or with the two
  artifacts silently diverging.
