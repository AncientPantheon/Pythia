# HANDOFF-REPLY — khronoton evented DETAIL schedule + system-cronoton delete

**Status: SHIPPED.** `@ancientpantheon/khronoton-core@0.8.0` is published on npmjs (`latest`).
**Bump your pin `^0.7.0 → ^0.8.0` and adopt.** This closes the last two evented-server-resolver UI gaps
from `HANDOFF-khronoton-evented-resolver-scheduleless.md` (Asks 5 & 6.1) — the Pythia automatic-link feature
is now complete end-to-end in the shared package.

## What landed

### Fix 1 — the DETAIL "Schedule" field now reads "Evented" (Ask 6.1)
The read-only cronoton detail card's **Schedule** field showed the stored `schedule_config` ("Daily at 12:00
UTC") for a trigger-only/evented row, even though **Next Fire** already read "—" and the **edit form** already
disabled the scheduler. Root cause: the detail derived trigger-only from runtime-arg keys only, ignoring
`external_fireable`. Fixed by extracting the list's predicate into a shared `isTriggerOnly(row)`
(`external_fireable === 1 || runtime-arg keys`) used by **both** the list next-fire cell and the detail
Schedule cell — they can no longer drift. An evented cronoton's detail now reads **Schedule: "Evented"**,
consistent with its "—" Next Fire and the disabled edit-form scheduler. Nothing to do on your side beyond the
bump — this is inside the bundled `@ancientpantheon/khronoton-core/ui`.

### Fix 2 — a system (server-resolver) cronoton is deletable behind a confirm-gated warning (Ask 5.2)
`DELETE /[id]` previously hard-refused any `server_resolver` row with `409 { protected: true }`. **0.8.0 adds
a confirm-gated `?force=1`** that permits the delete (the 409 still stands *without* force). It's threaded
through the package end-to-end:
- **Handler:** `DELETE /admin/khronoton/:id?force=1` (still behind the admin CONFIRM gate) deletes a system
  row; the audit records `forced: true`. Without `?force=1`, a `server_resolver` row still 409s exactly as
  before.
- **Adapter:** `ConfirmOpts.force` → `createFetchAdapter` sends `?force=1`, `createMemoryAdapter` passes
  `query: { force: "1" }`.
- **Hook:** `remove.run({ force: true })` (the `DeleteAction` run arg is widened to `DeleteRunOpts`).
- **Bundled Builder:** `deleteDisabled` now **enables** the Delete button for an admin on a system cronoton
  (non-admins are still blocked); clicking it shows a warning naming the resolver — *"This is the automaton's
  `<server_resolver>` template. Deleting it stops that capability until it's recreated. Delete anyway?"* —
  before the existing password confirm, then issues the forced delete.

**You can retire your API-only stopgap** `POST /admin/khronoton/:id/force-delete` — the capability is now in
the bundled Builder where the operator can reach it, and in the package's own `DELETE …?force=1`. (Keep it if
you still call it programmatically; it's harmless alongside the new path.)

## Compatibility
Ordinary scheduled cronotons, non-system deletes, and `delete(id)` / `remove.run()` **without** force are
byte-identical to 0.7.0. A system delete without force still 409s. All new surface (`ConfirmOpts.force`,
`DeleteRunOpts`, `deleteSystemConfirm`, the shared `isTriggerOnly`/`row-derive`) is additive — no breaking
removals, so the bump is drop-in.

## Still open (NOT in 0.8.0 — deferred by scope)
Per the handoff, 0.8.0 was scoped to exactly these two fixes. Still open for a future version if you want them:
Ask 5.1 (edit-time `externalFireable` patch), Ask 6.2 (a server-resolver ROSTER view), Ask 7 (URL-addressable
engine-UI routing). Say the word and we'll shape them.

— Khronoton, 2026-08-03 · 893 specs pass · typecheck clean
