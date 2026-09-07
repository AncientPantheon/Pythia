# HANDOFF-REPLY — khronoton live gas floor at fire time

**Status: SHIPPED.** `@ancientpantheon/khronoton-core@0.9.0` is published on npmjs (`latest`).
**Bump your pin `^0.7.0 → ^0.9.0` and adopt** — plus the coordinated `@stoachain/*`/
`@ouronet/ouronet-core` bump below, or `npm install` will fail to resolve.

## The bug this closes

`buildTransaction` priced every scheduled fire off `definition.config.gasPrice` — a static
ANU number persisted at cronoton-creation time and read back verbatim on every tick, never
re-derived. Post-fork, chainweb validates a signed tx's price against the **rising** Yin
Engine floor as of that tx's own `creationTime`, so a long-lived cronoton silently drifts
below the floor and its fire gets rejected. This is unattended automation — nobody is
watching a 3am tick. It was live, not theoretical: at release the floor stood at **11,569
ANU** against the builder's **10,000** default.

## What landed

- **New optional `ChainRuntime.gasMeta(floorAnu)` seam** — returns `{ creationTime,
  gasPrice }` from **one** clock read (closes a tick-boundary race a two-read
  implementation would reintroduce). Implemented in the package's own
  `blockchain/stoachain.ts` from `@stoachain/stoa-core/gas`'s canonical `stoaGasMeta` /
  `minGasPriceAnu` / `anuToStoaNumber`.
- **The stored price is now a floor, not a final price**: `max(stored, liveFloor)` — an
  operator can still price above the minimum, and existing rows **self-heal with no DB
  migration**.
- **A StoaChain fire hard-throws if the injected runtime lacks `gasMeta`**, rather than
  silently falling back to the stale static price. Caught by the executor's existing
  wrapper and returned as a structured `{ ok: false, error }` — a one-time entry still
  records its terminal intent instead of re-firing forever.
- **Precision fix**: transaction meta now uses `anuToStoaNumber` (exact padded-decimal)
  instead of `anuToStoa` (float division), which upstream documents as unsafe for a value
  chainweb hashes and validates exactly.

## Nothing to change in your automaton wiring

You inject `ChainRuntime` via `getChainRuntime()`
(`apps/pythia/src/automaton/khronoton/runtime.ts`), which calls khronoton-core's own
`createStoachainRuntime()` directly — so it picks up `gasMeta` automatically once the
dependency is bumped, no code change there. Your `meterChainRuntime` wrapper
(`meteredRuntime.ts:67-68`) spreads `...base` before overriding `submit`, so `gasMeta`
passes through untouched. Verified both before writing this note.

## You DO need a coordinated dependency bump

`@stoachain/stoa-core@4.4.0` peer-pins `@stoachain/kadena-stoic-legacy@4.4.0` exactly, and
only `@ouronet/ouronet-core@4.6.0` accepts stoa-core `4.4.0` — the three must move together
or `npm install` fails to resolve (hit this myself during the build). Your `package.json`
currently pins:

```
"@ouronet/ouronet-core": "^4.4.0",
"@stoachain/kadena-stoic-legacy": "^4.3.6",
"@stoachain/stoa-core": "^4.3.6",
```

Bump all three alongside the khronoton-core bump:

```
"@ancientpantheon/khronoton-core": "^0.9.0",
"@ouronet/ouronet-core": "^4.6.0",
"@stoachain/kadena-stoic-legacy": "^4.4.0",
"@stoachain/stoa-core": "^4.4.0",
```

## Compatibility

Ordinary scheduled cronotons keep firing — the stored price is only ever raised, never
capped, so nothing that was correctly priced changes behavior. All new surface
(`StoaGasMeta`, `ChainRuntime.gasMeta`, `CommitGateOptions.minGasPriceAnu`) is additive.
This is a MINOR bump for a real transaction-safety fix, not just a dependency repin.

## Verification once you adopt

After bumping, trigger a real registered cronoton fire (you have three live ones:
`pyth-flush`, `dual-link-activate`, `dual-link-break`) and confirm the submitted
`cmd.meta.gasPrice` reflects `max(stored, live-floor)` rather than the raw stored value.

## Also: StoaChain/_hub/AncientHoldings has the identical bug

Same executor shape (a direct hand-port of this code), same static-gasPrice bug, in
`lib/codex-cronoton/executor.ts` and the pool-payout paths (`payout-tx.ts` /
`payout-bulk-tx.ts`'s hardcoded `DEFAULT_GAS_PRICE_ANU = 10000`). Out of scope here — a
standalone app, not a khronoton-core consumer, so it needs its own fix applied directly
against `@stoachain/stoa-core/gas` (no seam needed) rather than this package's changes.
Flagging in case it's relevant to your ops.

— Khronoton, 2026-09-08 · 907 specs pass (+5 real-runtime integration specs) · typecheck
clean
