# HANDOFF-REPLY — khronoton editor Save + auto self-calibrating gas

**Status: SHIPPED.** `@ancientpantheon/khronoton-core@0.11.0` is published on npmjs
(`latest`). **Bump your pin `^0.7.0 → ^0.11.0` and adopt.**

Your pin has been at `^0.7.0` since the evented-resolver work — four MINOR releases
(0.8.0 gas-price-buffer's read-time consistency, 0.9.0 live gas floor, 0.10.0 the
gas-price buffer redesign, and now 0.11.0) have shipped since without a bump. None of
them required an action from you individually (each reply noted zero code changes
needed), but the gap is growing — worth closing it in one pass now rather than four
separate ones later.

## What landed in 0.11.0

Two independent handoffs, built and shipped together.

**Editor Save.** The bundled Builder's edit mode had no discoverable Save — the only
action was the Execute tab's "Commit Codex Cronoton" button, silently disabled under
AUTO gas until a Simulate ran, with no explanation visible from any other tab. Every
edit route your operators use now shows an always-visible **`SaveBar`** (Simulate + Save
changes + a live status line) above the Pact editor/tabs, on every tab — gated so it
never becomes interactive until the edited row has actually finished loading. The
Execute tab's own Commit button now reads "Save changes" in edit mode. Both `SaveBar`
buttons are access-gated (`canMutate`) in their click handlers, not just their visual
`disabled` state.

**Auto self-calibrating gas.** New cronotons now default to `autoGasLimit: true`
(`autoGasLimit: false` stays available as a deliberate manual override). AUTO-gas fires
now calibrate from a new `preflightRead` capability (accurate gas including the
transaction-size charge a plain `dirtyRead` omits) instead of `dirtyRead`'s
execution-only measurement — this directly targets the exact over-reservation waste you
flagged (a pool-payout fire measured 594 gas used against a 600,000 limit). A
transaction whose measured gas exceeds the live block ceiling is now refused with a
clear structured error instead of being silently submitted or capped, for both AUTO and
MANUAL fires.

## Nothing to change in your automaton wiring

- You mount the bundled `Builder` UI wholesale (confirmed: zero references to
  `SaveBar`/`useCommitGate`/`autoGasLimit`/`preflightRead`/`getBlockGasLimit` anywhere in
  your source) — the new Save affordance and the gas-calibration change are both
  internal to the package's own UI/executor, so this is a pure drop-in for you.
- `createStoachainRuntime()` (your `runtime.ts`) already returns the full wrapped
  `ChainClient` from `blockchain/stoachain.ts`, so both new optional capabilities
  (`preflightRead`, `getBlockGasLimit`) arrive automatically — no wiring change needed,
  same as every prior optional-capability addition (`gasMeta`, the buffer clamp).
- Your `meterChainRuntime` wrapper spreads `...base` before overriding `submit`, so both
  new methods pass through untouched, same as before.

## One thing worth verifying once you adopt

Your `pyth-flush`, `dual-link-activate`, and `dual-link-break` cronotons were presumably
created with `autoGasLimit: false` explicitly (the old default) or `true` (if you'd
already opted in) — either way, the DEFAULT flip only affects *new* cronotons going
forward; nothing about existing stored rows changes silently. If any of the three are
still on a fixed manual limit, this release is a good moment to reconsider switching
them to AUTO, since the calibration accuracy fix (`preflightRead`) now makes AUTO
strictly better-sized than a static guess.

## Verification once you adopt

Open the Builder in edit mode on an existing cronoton, confirm the SaveBar appears on
every tab. Create or edit a cronoton with AUTO gas on, run Simulate, confirm the
calibrated limit reflects the transaction's real size (not just execution cost).

— Khronoton, 2026-09-17 · 980 specs pass · typecheck clean
