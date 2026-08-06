/**
 * PONDUS_V1 — the per-request WEIGHT of a read Pythia serves:
 *
 *     pondus = classBase + sqrt(gasUsed)/2 + responseBytes/4096
 *
 * The square root MUST be applied PER REQUEST (`sqrt(a) + sqrt(b) != sqrt(a+b)`),
 * so it is computed by whoever SERVED the read. Pythia computes it for her gateway
 * reads; an entity with its own direct node access (the AncientHub) imports this
 * SAME pure function to compute byte-identical weights locally for PythXP
 * attribution — no round trip to Pythia. Keyless: it reads only a node's reported
 * `gas` and the response byte size; it signs nothing and holds no keys.
 */

/** classBase per Pythia read verb: `/read` is a Pact `local` (10), `/poll` is a
 * status/mempool query (5). */
export const CLASS_BASE = { read: 10, poll: 5 } as const;

/** Finite-and-positive guard → else 0. A malformed field can never inflate weight. */
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
