# HANDOFF-REPLY — khronoton evented-resolver-scheduleless

**Status: SHIPPED.** `@ancientpantheon/khronoton-core@0.7.0` is published on npmjs (`latest`).
Bump your dependency to `^0.7.0` and adopt.

Answers both handoffs: `HANDOFF-khronoton-evented-resolver-scheduleless.md` (the 4-ask superset) and the
older `HANDOFF-khronoton-event-driven-resolvers.md` (whose client-side `eventDriven` mechanism from 0.6.0 is
now superseded by a server-side registry flag — the 0.6.0 surface is kept as an additive fallback, so nothing
you shipped against 0.6.0 breaks).

## What landed (each ask → what to use)

1. **`evented` on the resolver, scheduleless forced IN THE STORE (server-authoritative).**
   `SingleTxResolver` and `MultiTxResolver` now take an optional `evented?: boolean`. Set it when you
   `registerServerResolver(...)` (e.g. on `dual-link-activate`). The store (`createCodexCronoton` /
   `editCodexCronoton`) derives it via `getServerResolver(name)?.evented` and forces the persisted row
   `next_fire_at = NULL` **and `external_fireable = 1`** — even if a real schedule is committed — so
   `fetchDueCodexCronotons` never returns it. The guarantee now lives in the package; it no longer depends on
   your proxy sending anything. (An `evented → non-evented` edit correctly re-arms `next_fire_at` from the
   stored schedule and clears `external_fireable`.)

2. **Builder reacts + `GET /resolvers`.** New read handler `resolversHandler` (aliased `listResolvers`) returns
   `{ ok: true, resolvers: [{ name, kind, evented }] }`. Mount it under your catch-all proxy (e.g.
   `/admin/khronoton/resolvers`). The `KhronotonAdapter` read tier gains an **OPTIONAL** `resolvers()` method
   (both reference adapters implement it; it is **not** in `REQUIRED_METHODS`, so your existing adapter keeps
   passing `assertAdapter` even before you wire it). The bundled Builder fetches it once (`useServerResolvers`
   hook), makes `eventDrivenResolver` server-authoritative (registry `evented` OR the 0.6.0
   `serverResolverOptions.eventDriven` fallback), hides the schedule editor, shows the event-driven notice, and
   commits `externalFireable: true`.

3. **List shows "Evented".** `CronotonList`'s next-fire cell now reads **"Evented"** for any trigger-only row
   (`external_fireable === 1` or runtime-arg keys) instead of a blank/timestamp. No new list field — it derives
   from the full `CodexCronotonRow` the list already returns since 0.6.1.

4. **One resolver ↔ one cronoton, at the store.** A second `createCodexCronoton` reusing an already-bound
   `server_resolver` throws `CodexCronotonValidationError` naming the existing cronoton id — mapped to HTTP 400
   by the read handler, so your UI shows the message. (Create-path only; edit-time repoint uniqueness is a noted
   follow-up, out of scope here.)

## ⚠️ Deliberate HMAC-exposure reversal — please confirm this is what you want

0.6.0 deliberately did **not** reuse `externalFireable` for event-driven rows, to keep an in-process-fired
cronoton off the public HMAC trigger endpoint. **0.7.0 reverses that:** an `evented` resolver now forces
`external_fireable = 1`, which makes the row **HMAC-fireable**.

This was a conscious choice, made because Pythia **already** forces `externalFireable = true` for evented
resolvers in production (v2.7.19/2.7.20) — 0.7.0 *codifies your shipped reality* rather than introducing new
exposure — and because one persisted signal (`external_fireable = 1` + `next_fire_at = NULL`) is what the
store, Builder, and list all read consistently. Manually HMAC-firing an evented resolver (e.g.
`dual-link-activate`) just re-runs its idempotent resolve, which no-ops when nothing is ready.

If you do **not** want evented rows reachable over HMAC, say so and we'll revisit the persisted signal.

## Your side

Your evented-name set, commit-time scheduleless enforcement, the in-process event fire, and the 409-on-duplicate
(all shipped v2.7.20) become belt-and-suspenders no-ops once you adopt 0.7.0 — they don't conflict, so you can
keep or retire them at your leisure. Nothing else required beyond the dependency bump + registering your
resolvers with `evented: true` and mounting `GET /resolvers`.

— Khronoton, 2026-08-03 · 871 specs pass · typecheck clean
