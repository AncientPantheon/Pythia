import { registerServerResolver } from "@ancientpantheon/khronoton-core/server";
import type { SingleTxResolver } from "@ancientpantheon/khronoton-core/server";
import type { PythLedger, FlushToken } from "../../pyth/ledger.js";

/**
 * The `pyth-flush` single-tx server resolver — the fire-time bridge between Pythia's
 * local Pyth ledger and the on-chain `PYTHIA|A_Flush(entries)` transaction (the drain
 * model; see docs/work/pyth-flush/design.md + docs/HANDOFF-pythia-khronoton-flush.md).
 *
 * A cronoton naming this resolver (`serverResolver: "pyth-flush"`) with pact code
 * `(…PYTHIA|A_Flush (read-msg "entries"))` gets its `entries` payload filled here at each
 * fire:
 *   - `resolve()` snapshots the current day-buckets into `entries[]` (WITHOUT mutating
 *     the ledger) and carries the drain token as the settle plan.
 *   - `settle()` — invoked by the Khronoton ONLY on a confirmed on-chain success —
 *     drains exactly what was sent. A failed/unfired flush never settles, so the same
 *     data simply retries next tick.
 *
 * Keyed automaton core: registered from the engine start (composition root) with the
 * live ledger instance, never a static import of Pythia's read-side singleton.
 */

/** The canonical resolver name a flush cronoton must reference in `serverResolver`. */
export const PYTH_FLUSH_RESOLVER = "pyth-flush";

export function createPythFlushResolver(ledger: PythLedger): SingleTxResolver {
  return {
    kind: "single-tx",
    resolve() {
      const { entries, token } = ledger.beginFlush();
      return { plan: [token], payload: { entries } };
    },
    settle(plan) {
      const token = plan[0] as FlushToken | undefined;
      if (token) ledger.commitFlush(token);
    },
  };
}

/** Register the resolver in the package's global registry so the tick can consult it. */
export function registerPythFlushResolver(ledger: PythLedger): void {
  registerServerResolver(PYTH_FLUSH_RESOLVER, createPythFlushResolver(ledger));
}
