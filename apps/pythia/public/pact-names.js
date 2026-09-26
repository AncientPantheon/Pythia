/**
 * Frontend mirror of `src/pact/names.ts` — the ONE place the browser learns a Pact name.
 *
 * `app.js` is served statically and cannot import the TypeScript inventory, so this file
 * mirrors it. THE MIRROR IS ENFORCED: `src/pact/names.test.ts` parses this file and fails
 * the suite if it drifts from `names.ts` by even one character of a function name.
 *
 * Do not hand-edit a name here. Change `src/pact/names.ts`, run the suite, and copy what it
 * tells you — the boot check only validates the backend inventory against the deployed
 * module, so a name invented here alone would be exactly the silent breakage this file
 * exists to end (the Connectors panel read empty for days that way in 2026-09).
 */

/** The Ouronet namespace every Pythia Pact call lives under. */
export const PACT_NAMESPACE = "ouronet-ns";

/** The core registry/ledger module Pythia reads. */
export const PYTHIA_MODULE = "PYTHIA";

/** Fully-qualified deployed module identifier. */
export const PYTHIA_QUALIFIED = `${PACT_NAMESPACE}.${PYTHIA_MODULE}`;

/** Deployed function names, keyed exactly as `src/pact/names.ts` keys them. */
export const PYTHIA_FN = {
  listActiveDualLinks: "URH_ListActiveDualLinks",
  listInactiveDualLinks: "URH_ListInactiveDualLinks",
  listAllDualLinks: "URH_ListAllDualLinks",
  listAllApiKeys: "URH_ListAllApiKeys",
  counterpart: "UR_Counterpart",
  publicKey: "UR_Public",
  ledgerEpochStart: "UR_PythLedgerEpochStart",
  pythTotal: "UR_PythTotal",
  pythDay: "UR_PythDay",
};

/** Declared arity per key — a short Pact call is partially applied, not an error. */
export const PYTHIA_ARITY = {
  listActiveDualLinks: 0,
  listInactiveDualLinks: 0,
  listAllDualLinks: 0,
  listAllApiKeys: 0,
  counterpart: 1,
  publicKey: 1,
  ledgerEpochStart: 0,
  pythTotal: 0,
  pythDay: 1,
};

/**
 * Build a `ouronet-ns.PYTHIA` read expression. Throws on an unknown key or a wrong argument
 * count, so a typo fails here rather than rendering an empty panel.
 */
export function pythiaRead(key, args = []) {
  const fn = PYTHIA_FN[key];
  if (!fn) throw new Error(`pythiaRead: unknown Pact name key "${key}"`);
  const arity = PYTHIA_ARITY[key];
  if (args.length !== arity) {
    throw new Error(`pythiaRead(${key}): ${fn} takes ${arity} argument(s), got ${args.length}`);
  }
  return `(${[`${PYTHIA_QUALIFIED}.${fn}`, ...args].join(" ")})`;
}
