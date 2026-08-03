# pyth-flush-pact-value-encoding — Design

Quick-scale bugfix (operator-reported: the Pyth Flush cronoton's simulate failed a Pact type check).
Post-hoc record.

## Problem

Simulating the Pyth Flush cronoton (`(ouronet-ns.TS01-C4.PYTHIA|A_Flush (read-msg "entries"))`) failed
with a Pact type-check error: the argument didn't match the on-chain
`[object{PythiaLedgerV2.PYTHIA|S|PythFlushEntry}]` schema. That schema is `day:integer`,
`iz-complete:bool`, `petitions:integer`, `pondus:DECIMAL`, and four more `integer` counters. The Pact
code + schema are correct and fixed on-chain; the fault was in the DATA the `pyth-flush` resolver
supplied.

Root cause: the resolver put RAW JS numbers into the `entries` payload. Kadena forbids a bare number
in a Pact command — `@stoachain`/`@kadena`'s value parser throws *"Type `number` is not allowed in the
command. Use `{ decimal: … }` or `{ int: … }` instead"* — and even in `env-data` a bare number can't
reliably reproduce the schema's `integer` vs `decimal` typing when read back via `read-msg`. In
particular `pondus` (the only `decimal`) is unrepresentable as a bare number: a whole value like `40`
serializes as a JSON integer and fails the `decimal` field. Because the flush FIRE simulates before it
submits (a safety guard), this blocked the flush entirely, not just the manual simulate.

## Approach

Encode every numeric field of each flush entry into its explicit Kadena Pact-value form BEFORE it goes
into the `entries` payload: `{ int: "<n>" }` for `day` + the six integer counters, `{ decimal: "<n>" }`
for `pondus`, and leave `iz-complete` (a bool) as-is. Done in `pythFlushResolver.ts` (a new
`toChainFlushEntry` mapper applied in `resolve()`), NOT in `PythLedger.beginFlush()` — so the admin
Pyth Flush panel / `previewEntries()` keep their plain-number shape and only the on-chain payload
carries the Pact-typed encoding.

## Acceptance criteria

- [x] Each entry in the resolver's `entries` payload encodes `pondus` as `{ decimal: … }` (including a
      whole value) and the six integer counters + `day` as `{ int: … }`; `iz-complete` stays a bool —
      `pythFlushResolver.test.ts`.
- [x] `PythLedger.beginFlush()`/`previewEntries()` (the admin UI's data source) are unchanged — still
      plain numbers.
- [x] `settle()`/drain path unchanged (operates on the token, not the payload).
- [x] typecheck + full suite green.

## Out of scope

- Any change to the on-chain `A_Flush` / the Pact code (correct as-is).
- Confirming the fix end-to-end against the live chain (can't dry-run a real submit from here) — the
  encoding now matches the schema's declared types, which was the reported failure.
