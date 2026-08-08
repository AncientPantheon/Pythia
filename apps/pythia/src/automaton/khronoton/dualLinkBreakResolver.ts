import { registerServerResolver } from "@ancientpantheon/khronoton-core/server";
import type { SingleTxResolver } from "@ancientpantheon/khronoton-core/server";
import type { PendingBreakTracker } from "../../connectors/auth/pendingBreakTracker.js";

/**
 * The `dual-link-break` single-tx server resolver — the fire-time bridge between
 * Pythia's `PendingBreakTracker` (an ancient-admin-queued revocation, via the
 * `/admin/connectors/break` route) and the on-chain revoke transaction. The exact
 * inverse of `dualLinkActivateResolver.ts`, but operator-initiated rather than
 * proof-event-driven, and it revokes ONE link (identified by its composite
 * `dual-link-key`) per fire.
 *
 * A cronoton naming this resolver (`serverResolver: "dual-link-break"`) MUST use
 * the on-chain revoke pact code, which takes the selected dual API key as a single
 * string arg named `dualAPI`:
 *
 *     (ouronet-ns.TS01-C4.PYTHIA|A_RevokeLink (read-msg "dualAPI"))
 *
 * The resolver fills `dualAPI` from the queue at each fire:
 *   - `resolve()` snapshots the oldest queued break (WITHOUT mutating it) and
 *     carries its token as the settle plan. When nothing is queued it returns a
 *     genuinely empty/no-op fire (empty plan, blank `dualAPI`) — the same
 *     "nothing to do" shape the activate/flush resolvers use.
 *   - `settle()` — invoked by the Khronoton ONLY on a confirmed on-chain success —
 *     commits (removes) exactly the break that was sent. A failed/unfired attempt
 *     never settles, so the same link simply retries on the next fire.
 *
 * Keyed automaton core: registered from the engine start (composition root) with
 * the live tracker instance.
 */

/** The canonical resolver name a dual-link-break cronoton must reference in `serverResolver`. */
export const DUAL_LINK_BREAK_RESOLVER = "dual-link-break";

export function createDualLinkBreakResolver(tracker: PendingBreakTracker): SingleTxResolver {
  return {
    kind: "single-tx",
    // EVENT-DRIVEN: fired on-demand by the ancient-admin "API Break" action (the
    // admin route's executeNow), never a schedule. `evented: true` forces the
    // cronoton scheduleless on commit/edit and renders it "Evented" in the Builder.
    evented: true,
    resolve() {
      const ready = tracker.beginBreak();
      if (!ready) {
        return { plan: [], payload: { dualAPI: "" } };
      }
      return { plan: [ready.token], payload: { dualAPI: ready.dualLinkKey } };
    },
    settle(plan) {
      const token = plan[0] as string | undefined;
      if (token) tracker.commitBreak(token);
    },
  };
}

/** Register the resolver in the package's global registry so the tick can consult it. */
export function registerDualLinkBreakResolver(tracker: PendingBreakTracker): void {
  registerServerResolver(DUAL_LINK_BREAK_RESOLVER, createDualLinkBreakResolver(tracker));
}
