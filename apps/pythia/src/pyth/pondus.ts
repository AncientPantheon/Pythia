/**
 * PONDUS_V1 — the per-request WEIGHT of a read Pythia serves, per
 * `docs/HANDOFF-hub-pondus-metering.md`:
 *
 *     pondus = classBase + sqrt(gasUsed)/2 + responseBytes/4096
 *
 * The square root MUST be applied PER REQUEST (`sqrt(a) + sqrt(b) != sqrt(a+b)`)
 * — which is exactly why this computation lives on Pythia's side of the wire.
 * Keyless: it reads only the node's reported `gas` and the response byte size;
 * it signs nothing and holds no keys. Round the WINDOW SUM (not each request) to
 * <=3 decimals at surface time via {@link round3}.
 */

/** classBase per Pythia read verb — the handoff's endpoint classes mapped to
 * Pythia's surface: `/read` is a Pact `local` (10), `/poll` is a status/mempool
 * query (5). */
export const CLASS_BASE = { read: 10, poll: 5 } as const;

/** Finite-and-positive guard → else 0. A malformed node field can never inflate weight. */
function nonNeg(x: number): number {
  return Number.isFinite(x) && x > 0 ? x : 0;
}

export function pondus(input: {
  classBase: number;
  gasUsed: number;
  responseBytes: number;
}): number {
  const base = Number.isFinite(input.classBase) ? input.classBase : 0;
  return base + Math.sqrt(nonNeg(input.gasUsed)) / 2 + nonNeg(input.responseBytes) / 4096;
}

/** Round to <=3 decimals — the ledger/report surface rounding for a summed window. */
export function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
