# khronoton-builder-back-button — Design

Quick-scale fix (operator-reported: opening the Khronoton Builder to edit an existing cronoton
stranded them with no Save or Back button). Post-hoc record per `docs/work/` convention.

## Problem

khronoton-core's `<Builder>` component only ever LEAVES its screen via a successful **Commit** (its
`onDone` callback fires with the new/edited id). It ships **no cancel/back affordance of its own**.
So an admin who opens it — especially to *edit* an existing cronoton — has no way out except to save,
which is a real "stranded" bug. Compounding it: the **Save action is the Commit button, which lives
on the Builder's Execute tab** (the last of five tabs), so from any other tab (e.g. Signatures) there
appears to be no save button at all.

## Approach

The Back part is fixable entirely from Pythia's side: `apps/pythia/khronoton-ui/KhronotonApp.tsx`
renders `<Builder>` bare, with no surrounding chrome, even though it already owns the navigation
state (`setScreen`). Add a **Back** control in the chrome above the Builder that navigates back to the
edited cronoton's detail (or the list, for a brand-new one), discarding unsaved edits — mirroring the
existing `onDone` target logic. `.pyth-khr-backbar` styling added to `khronoton-island.css`.

The Save part is NOT missing — it's the package's Commit button on the Execute tab. That's a
khronoton-core discoverability question (a more prominent/always-visible save, and/or a proper
in-Builder Cancel button that calls `onDone()` — a path the `onDone` contract already anticipates,
since KhronotonApp's `onDone` already handles an undefined id as "cancel → list"). Left to a
khronoton-core follow-up; the Pythia-side Back button resolves the immediate stranding.

## Acceptance criteria

- [x] The Builder screen shows a Back button (both when editing an existing cronoton and creating a
      new one) that returns to the detail/list without committing.
- [x] Back's label notes it discards unsaved edits when editing.
- [x] `node --check` on the built island passes; typecheck + full suite green (islands have no
      automated test harness, per this repo's established convention — verified via id/build checks).

## Out of scope

- A proper in-Builder Cancel button and more discoverable Save/Commit — those are khronoton-core
  `<Builder>` component concerns (the Builder's own JSX), not something Pythia can change by
  consuming it. Candidate for the existing Khronoton Builder handoff.
