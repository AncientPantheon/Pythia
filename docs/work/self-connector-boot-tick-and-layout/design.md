# self-connector-boot-tick-and-layout — Design

Quick-scale fix (two small, well-understood, independently-scoped bugs reported live by the
operator against the Self Connector admin panel) — post-hoc record per this repo's `docs/work/`
convention.

## Problem 1 — layout: the account address visually collided with the state chip

`admin.html`'s per-half rows crammed the label + full 162-char account address + state chip onto
one `.deploy-row` flex line. The address is a genuinely unbreakable string (no spaces), so it
couldn't wrap; `.deploy-row-name` had `min-width: 0` (letting the flex box itself shrink) but no
`overflow`/`text-overflow` handling, so the address text bled out past its shrunk box and visually
overlapped the "NOT LINKED" chip sitting beside it — illegible, and looked broken.

**Fix:** restructured each half into its own bordered "zone" (`.acct-card`), mirroring the Codex
tab's own account-box treatment: a top line with the label + chip (their own space, never
colliding), and the address on its own line below, truncated with a CSS ellipsis
(`white-space: nowrap; overflow: hidden; text-overflow: ellipsis`) that naturally shortens to fit
whatever width the zone has — plus a `title` attribute so the full address is still available on
hover. `apps/pythia/public/admin.html`, `admin.js`, `styles.css`.

## Problem 2 — every redeploy showed a false "Not linked" for up to 24h

Reported: "why is it unlinked, do i have to link again?" — a fair question, since the pasted
dual-link-key IS still sealed and persisted (`SealedStore`, survives restarts) and nothing about it
was actually lost. The bug: `SelfConnectorLoop.start()` only calls `setInterval(...)`, which fires
its *first* tick only after a full `intervalMs` elapses — 24h for Pythia. The loop's own cached
per-half status starts every fresh process boot at `"not-linked"` regardless of whether a key is
already on file, so every redeploy left the admin looking at a false "not-linked" for up to 24h
even though the underlying key was perfectly good — the exact same stale-status gap `v2.7.2`
already fixed on the *paste* path (`selfConnector.link()` now drives an immediate `tick()`), just
never closed on the *boot* path.

**Fix:** `start()` now also fires one immediate `tick()` (fire-and-forget, not awaited — a
slow/unreachable chain read must never delay the gateway's own boot), in addition to starting the
periodic interval. `tick()` never throws (`DualLinkConnector` isolates each half's own failure
internally), matching the exact reasoning `link()`'s own doc comment already established for
awaiting it directly on the paste path. `apps/pythia/src/automaton/selfConnectorLoop.ts`.

## Acceptance criteria

- [x] The per-half account zones render as bordered boxes with the chip and address never
      visually overlapping, at any width — address ellipsis-truncates instead.
- [x] `SelfConnectorLoop.start()` fires an immediate tick, proven by a new test using a 24h
      interval (long enough that only the immediate tick, not the periodic one, could produce a
      verify call within the test's timeout) — `selfConnectorLoop.test.ts`.
- [x] The operator does NOT need to re-paste the dual-link-key after this ships — the next
      redeploy's boot self-heals the status via the immediate tick, using the already-sealed key.
- [x] Full suite + typecheck green.

## Out of scope

- Codex's own React account-box component isn't reused verbatim (it's a compiled bundle from a
  separate package, `@ancientpantheon/codex`) — this mirrors its *visual treatment* in plain
  HTML/CSS, matching this panel's existing hand-rolled admin UI convention.
