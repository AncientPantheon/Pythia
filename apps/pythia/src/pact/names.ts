/**
 * The ONE inventory of every Pact name Pythia calls.
 *
 * WHY THIS FILE EXISTS — read before adding a name.
 *
 * A Pact call that names a function which does not exist is a RESOLUTION error: `try`
 * cannot catch it, nothing throws at the call site, and a fail-closed cache turns it into
 * "nobody is authorised" rather than "this read is broken". That has now happened three
 * times on this service:
 *
 *   1. v3.0.2  `UR_ActiveDualLinkSet`     — never existed; every consumer read as inactive,
 *                                           all `/verify` -> 202 pending, fleet-wide.
 *   2. the fix `URD_ListActiveDualLinks`  — ALSO not a member; reproduced the same outage.
 *   3. 2026-09-26 `URD_List*` (frontend)  — the PYTHIA module was redeployed (URD_ -> URH_)
 *                                           between 09-11 and 09-26; the Connectors panel
 *                                           and Activity lane pills silently read empty.
 *
 * Care was never the missing ingredient — a source of truth was. So: no call site types a
 * module or function name. They ask for a key here, and {@link assertPactNamesExist} checks
 * every one of them against the DEPLOYED module at boot.
 *
 * NOTE on `@ouronet/talos-registry`: it is a dependency and its version + surfaceHash are
 * reported in health, but it is NOT the source of truth for these names and cannot be — it
 * carries the transaction-callable surface (423 entrypoints over 12 Talos modules) and
 * ZERO reader functions. `tryGetEntrypoint("PYTHIA.URH_ListActiveDualLinks")` is `undefined`
 * exactly as the broken `URD_` spelling is, so it cannot tell them apart. The chain can.
 */

/** The Ouronet namespace every Pythia Pact call lives under. */
export const PACT_NAMESPACE = "ouronet-ns";

/** The core registry/ledger module Pythia reads. */
export const PYTHIA_MODULE = "PYTHIA";

/** Fully-qualified deployed module identifier, e.g. `ouronet-ns.PYTHIA`. */
export const PYTHIA_QUALIFIED = `${PACT_NAMESPACE}.${PYTHIA_MODULE}` as const;

export interface PactNameSpec {
  /** The deployed function name. */
  readonly fn: string;
  /** Declared parameter count (0 = nullary). Used by the ghost call in the boot check. */
  readonly arity: number;
  /** Where this is called from — quoted verbatim if the name ever goes missing. */
  readonly usedBy: string;
}

/**
 * Every `ouronet-ns.PYTHIA` name this service calls, backend and frontend.
 *
 * Adding a caller? Add it here first. The boot check and `names.test.ts` walk this map, so a
 * name that is not in it is unverified, and a name here that the chain does not have fails
 * startup by name.
 */
export const PYTHIA_NAMES = {
  /** Active dual links — the fail-closed auth cache. The one that broke twice. */
  listActiveDualLinks: {
    fn: "URH_ListActiveDualLinks",
    arity: 0,
    usedBy: "connectors/auth/dualLinkCache.ts — keyless auth cache (FAIL-CLOSED)",
  },
  listInactiveDualLinks: {
    fn: "URH_ListInactiveDualLinks",
    arity: 0,
    usedBy: "public/app.js — Connectors panel, inactive filter",
  },
  listAllDualLinks: {
    fn: "URH_ListAllDualLinks",
    arity: 0,
    usedBy: "public/app.js — Connectors panel + Activity consumer lanes",
  },
  listAllApiKeys: {
    fn: "URH_ListAllApiKeys",
    arity: 0,
    usedBy: "public/app.js — Connectors panel, Apollo halves list",
  },
  counterpart: {
    fn: "UR_Counterpart",
    arity: 1,
    usedBy: "connectors/auth/readApolloCounterpart.ts — dual-link pairing",
  },
  publicKey: {
    fn: "UR_Public",
    arity: 1,
    usedBy: "connectors/verify/readApolloPublicKey.ts — Apollo ownership verify",
  },
  ledgerEpochStart: {
    fn: "UR_PythLedgerEpochStart",
    arity: 0,
    usedBy: "pyth/epochReader.ts — ledger day-ordinal anchor",
  },
  pythTotal: {
    fn: "UR_PythTotal",
    arity: 0,
    usedBy: "public/app.js — StoaChain Activity, on-chain totals",
  },
  pythDay: {
    fn: "UR_PythDay",
    arity: 1,
    usedBy: "public/app.js — StoaChain Activity, per-day rows",
  },
} as const satisfies Record<string, PactNameSpec>;

export type PythiaNameKey = keyof typeof PYTHIA_NAMES;

/** Every inventory key, for the boot check and the drift test. */
export function pythiaNameKeys(): PythiaNameKey[] {
  return Object.keys(PYTHIA_NAMES) as PythiaNameKey[];
}

/** The deployed function name for a key. Never hand-type these at a call site. */
export function pythiaFn(key: PythiaNameKey): string {
  return PYTHIA_NAMES[key].fn;
}

/**
 * Build a `ouronet-ns.PYTHIA` read expression.
 *
 * `args` are spliced verbatim as already-formatted Pact literals — callers that pass user
 * input must use a `read-string` binding rather than interpolating, exactly as the existing
 * readers do. Throws when the argument count disagrees with the declared arity, so a short
 * call (which Pact would silently PARTIALLY APPLY, returning a closure instead of erroring)
 * fails here instead.
 */
export function pythiaRead(key: PythiaNameKey, args: readonly string[] = []): string {
  const spec = PYTHIA_NAMES[key];
  if (args.length !== spec.arity) {
    throw new Error(
      `pythiaRead(${key}): ${spec.fn} takes ${spec.arity} argument(s), got ${args.length}. ` +
        `A short Pact call is partially applied, not an error — refusing to build it.`,
    );
  }
  const call = [`${PYTHIA_QUALIFIED}.${spec.fn}`, ...args].join(" ");
  return `(${call})`;
}
