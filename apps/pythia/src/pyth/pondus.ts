/**
 * The per-request pondus WEIGHT now lives in `@ancientpantheon/pythia-client`
 * (`pondus()` + `CLASS_BASE`) so it is the ONE source of truth shared with any
 * entity that computes weights off its own direct node access (the AncientHub).
 * Pythia re-exports it here to keep the internal `pyth/pondus.js` import path
 * stable. `round3` (the ledger/report SURFACE rounding of a summed window) is
 * Pythia-internal and stays here.
 */
export { pondus, CLASS_BASE } from "@ancientpantheon/pythia-client";

/** Round to <=3 decimals — the ledger/report surface rounding for a summed window. */
export function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
