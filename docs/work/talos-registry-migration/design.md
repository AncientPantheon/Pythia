# Pact name inventory + boot-time existence check (talos-registry adoption)

## Why

`URD_*` → `URH_*`: the PYTHIA module was redeployed between 2026-09-11 and 2026-09-26.
Evidence: `URD_ListAllDualLinks` returned 6 rows on 09-11 and returns
`has no such member` today. A Pact call naming a missing function is a RESOLUTION error —
`try` cannot catch it, nothing throws at the call site — and a fail-closed cache turns it
into "nobody is authorised" rather than "this read is broken".

This is the third occurrence (v3.0.2 `UR_ActiveDualLinkSet`, then `URD_ListActiveDualLinks`,
now the frontend's four).

## What the audit found (measured, 2026-09-26)

**The brief's proposed source of truth does not cover Pythia's surface.**
`@ouronet/talos-registry@1.1.0` carries **zero** reader functions:
`keys matching /\.(UR|URH|URD|URC)_/ === 0`, `keys starting "PYTHIA." === 0`. It is the
transaction-callable surface (423 entrypoints over 12 Talos modules). Of these, 4 relate to
PYTHIA, all `TS01-C4.PYTHIA|C_*` — none of which Pythia's source builds.

Therefore:
- `tryGetEntrypoint("PYTHIA.URD_ListActiveDualLinks")` → `undefined`, **and so is `URH_`**.
  The registry cannot distinguish the broken name from the working one.
- `resolveByName("ListActiveDualLinks")` **throws** `RegistryError`; it does not offer `URH_`.
- A boot check validating Pythia's names against the registry would reject every one of them
  and refuse to boot a healthy service.

**The brief's inventory was also narrower than its claim** (the failure it warns about): it
scanned `src/` only and missed `public/app.js`, which had four dead `URD_` names on live
call paths — the Connectors panel and Activity lane pills were silently empty in production.

## Decision

Keep `@ouronet/talos-registry` as a `dependency` at `^1.1.0` (correct for a deployed service;
useful for the 4 `TS01-C4.PYTHIA|C_*` builders and future transaction work), and report its
version + `surfaceHash` in health. But make **the chain** the source of truth for existence,
because that is what actually covers Pythia's reader surface.

1. **One inventory** (`src/pact/names.ts`) — every Pact name Pythia calls, with module, arity
   and call site. Replaces the three scattered `PYTHIA_NS = "ouronet-ns"` aliases and the
   `EPOCH_CODE` literal. Callers build code via `pactRead()`; nobody types a name.
2. **Frontend copy** (`public/pact-names.js`) — app.js is static and cannot import TS. A test
   parses it and asserts it matches `names.ts` exactly, so drift fails the suite.
3. **Boot-time existence check** (`src/pact/existenceCheck.ts`) — ONE `describe-module` for
   PYTHIA, assert every inventory name is a `defun` in the deployed code. Names the dead
   symbol. Distinguishes `has no such member` (missing) from `No value found in table`
   (present, empty row).
4. **Health** reports `talosRegistry.version` + `surfaceHash` + the deployed PYTHIA
   `moduleHash` (changes on any redeploy — the signal that would have caught all three rounds).
5. **Test** walks every inventory key, and bans the `URD_` family outright.

## Not doing

No rewriting shim at the transport. Pythia is the chokepoint; a shim there would hide every
consumer's staleness from every host. Diagnose, never rewrite — the boot check names the dead
symbol and fails loudly.
