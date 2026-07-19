/**
 * Pythia's KEYED automaton core — the sovereign half of the entity (`automaton/02`).
 *
 * Everything under `src/automaton/` is the Codex (signing keys) + the Khronoton
 * (scheduled autonomous signing) + the chain runtime that signs+submits Pythia's OWN
 * transactions. It is SIGNING code by design, so the keyless invariant does NOT apply
 * here — the `keylessScanner` skips this directory (`AUTOMATON_CORE_DIR`).
 *
 * The keyless guarantee is instead a property of the CONSTRUCTOR face ("Pythiaeyes" —
 * the client request path) PLUS a hard isolation boundary: no module outside this
 * directory may import from it, proven by `scanForAutomatonImports`. A client request
 * therefore can never reach the Codex or a signature.
 *
 * Contents arrive in later topics (codex-custody, khronoton-engine, sovereign-actions);
 * this marker establishes the boundary so the scanner rescope + isolation test are live
 * from the start.
 */
export const AUTOMATON_CORE = "automaton" as const;
