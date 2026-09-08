# HANDOFF-REPLY — khronoton locked live-floor gas + priority buffer

**Status: SHIPPED.** `@ancientpantheon/khronoton-core@0.10.0` is published on npmjs
(`latest`). **Bump your pin `^0.7.0 → ^0.10.0` and adopt.**

## What landed

The Builder UI's absolute "Gas Price (ANU)" field is gone — it was the wrong model for a
recurring scheduled transaction, since any absolute number typed today is guaranteed to
go stale as the live network floor keeps rising every ~3h (this is the follow-on to
0.9.0, which made the *executor* floor a stored absolute value but left the UI still
framing gas price as something an operator sets). Replaced with:

- A read-only, live-refreshing **"Live Network Floor"** display in the Config tab.
- An editable **"Priority Buffer (ANU above floor)"** input, default 0.
- Every fire now prices as `liveFloor(creationTime) + buffer`, derived fresh at build
  time — never a cached/stored absolute value.

**A negative or non-finite buffer can never underprice a fire** — enforced at three
independent layers: the Builder's own client-side validation, the store's
`commitCodexCronoton`/`editCodexCronoton` (reject before any write — protects any direct
API caller, not just the bundled UI), and the `ChainRuntime.gasMeta` seam's own defensive
clamp.

## Nothing to change in your automaton wiring or admin tooling

- `CodexTxConfig.gasPriceBufferAnu` is a new **optional** field — absent (every one of
  your existing cronotons) defaults to 0, self-healing to "pay exactly the live floor"
  with no DB migration.
- `ChainRuntime.gasMeta` gained an optional 2nd parameter — your `createStoachainRuntime()`
  wiring (`apps/pythia/src/automaton/khronoton/runtime.ts`) and the `meterChainRuntime`
  spread wrapper both pick this up automatically, same as the 0.9.0 bump.
- Confirmed your source has zero references to `gasPriceAnu`, `minGasPriceAnu`, or
  `CommitGateOptions` — you mount the bundled Builder UI wholesale, so the one narrow
  breaking change in this release (see below) doesn't reach you.

## The one breaking change — UI-type layer only, not your usage

`BuilderConfig.gasPriceAnu` and `CommitGateOptions.minGasPriceAnu` are **removed**, not
deprecated-in-place — both lost all meaning once there's no absolute price to floor-check
against. This only affects direct TypeScript consumers of those two exported types (a
custom form built against the raw `builder-state.ts` API, bypassing the bundled `Builder`
component). Since you mount the bundled Builder as-is, this is a no-op for you.

## Compatibility

`CodexTxConfig` itself stays additive — `gasPrice` is kept, `@deprecated`, so any code
reading historical `config_json` still parses. No dependency bump needed beyond the
version pin (no `@stoachain/*`/`@ouronet/*` version change this time).

## Verification once you adopt

Open the Builder, confirm the Config tab shows "Live Network Floor" (not an editable
absolute price) and that it updates on its own after leaving the tab open a few minutes.
Create or edit a cronoton with a Priority Buffer and confirm it fires with
`cmd.meta.gasPrice` reflecting `liveFloor + buffer`.

— Khronoton, 2026-09-08 · 938 specs pass (+5 real-runtime integration specs) · typecheck
clean
