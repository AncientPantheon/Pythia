import { registerServerResolver } from "@ancientpantheon/khronoton-core/server";
import type { SingleTxResolver } from "@ancientpantheon/khronoton-core/server";
import type { PendingActivationTracker } from "../../connectors/auth/pendingActivationTracker.js";

/**
 * The `dual-link-activate` single-tx server resolver — the fire-time bridge between
 * Pythia's `PendingActivationTracker` (two independent per-half headless proofs,
 * `connectorAuth.ts`'s verify route) and the on-chain `PYTHIA|A_LinkDualApiKey(standard,
 * smart)` transaction (see docs/work/connector-activation-resolver/design.md). Mirrors
 * `pythFlushResolver.ts`'s drain-resolver shape, adapted for a single pair instead of a
 * batch — `A_LinkDualApiKey` takes both halves in one call, so at most one pair fires per
 * tick.
 *
 * A cronoton naming this resolver (`serverResolver: "dual-link-activate"`) with pact code
 * `(…PYTHIA|A_LinkDualApiKey (read-msg "standardApollo") (read-msg "smartApollo"))` gets
 * its payload filled here at each fire:
 *   - `resolve()` snapshots the oldest ready pair from the tracker (WITHOUT mutating it)
 *     and carries the pair's token as the settle plan. When no pair is ready, it returns a
 *     genuinely empty/no-op fire (empty plan, blank accounts) — the flush resolver's
 *     "nothing to do" shape applied to a single pair instead of a batch.
 *   - `settle()` — invoked by the Khronoton ONLY on a confirmed on-chain success — commits
 *     exactly the pair that was sent. A failed/unfired attempt never settles, so the same
 *     pair simply retries next tick.
 *
 * Keyed automaton core: registered from the engine start (composition root) with the live
 * tracker instance, never a static import of Pythia's read-side singleton.
 */

/** The canonical resolver name a dual-link-activate cronoton must reference in `serverResolver`. */
export const DUAL_LINK_ACTIVATE_RESOLVER = "dual-link-activate";

export function createDualLinkActivateResolver(tracker: PendingActivationTracker): SingleTxResolver {
  return {
    kind: "single-tx",
    resolve() {
      const ready = tracker.beginActivation();
      if (!ready) {
        return { plan: [], payload: { standardApollo: "", smartApollo: "" } };
      }
      const { pair, token } = ready;
      return { plan: [token], payload: { standardApollo: pair.standard, smartApollo: pair.smart } };
    },
    settle(plan) {
      const token = plan[0] as string | undefined;
      if (token) tracker.commitActivation(token);
    },
  };
}

/** Register the resolver in the package's global registry so the tick can consult it. */
export function registerDualLinkActivateResolver(tracker: PendingActivationTracker): void {
  registerServerResolver(DUAL_LINK_ACTIVATE_RESOLVER, createDualLinkActivateResolver(tracker));
}
