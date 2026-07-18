import type { AdvertisedSlot } from "./serviceClient.js";
import type { NodeReachability, NodeReachabilityReason } from "../health/probeNodes.js";

/** One row in the admin's Observation Pool node table: the advertised slot enriched
 * with Pythia's own reachability verdict. Earnings fields pass through when present. */
export interface EnrichedNode extends AdvertisedSlot {
  reachable: boolean;
  reason: NodeReachabilityReason | null;
}

/** Highest-earning-first when the hub returns earnings; else reachable-first then id.
 * `slotStoicismEarned` is a decimal STRING (token units) — compare numerically. */
function compareNodes(a: EnrichedNode, b: EnrichedNode): number {
  // A hub-supplied value that isn't a finite number (garbage decimal, NaN) is
  // treated as absent — never let it reach the comparator, which would return NaN
  // and corrupt the whole sort.
  const finite = (x: number | string | undefined): number | null => {
    if (x === undefined) return null;
    const v = Number(x);
    return Number.isFinite(v) ? v : null;
  };
  const earn = (n: EnrichedNode): number | null =>
    finite(n.slotStoicismEarned) ?? finite(n.slotRewardedRequests) ?? finite(n.operatorPythXP);
  const ea = earn(a);
  const eb = earn(b);
  if (ea !== null || eb !== null) return (eb ?? -1) - (ea ?? -1); // earnings desc
  if (a.reachable !== b.reachable) return a.reachable ? -1 : 1; // reachable first
  return a.id.localeCompare(b.id);
}

/**
 * Merge each advertised slot with its {@link NodeReachability} (matched by url) and
 * sort for display. A slot with no probe result defaults to unreachable. Pure — no
 * I/O, so it's unit-tested independently of the probe and the route.
 */
export function enrichHubNodes(
  advertised: AdvertisedSlot[],
  reachabilities: NodeReachability[],
): EnrichedNode[] {
  const byUrl = new Map(reachabilities.map((r) => [r.url, r]));
  return advertised
    .map((slot): EnrichedNode => {
      const r = byUrl.get(slot.url);
      return {
        ...slot,
        reachable: r?.reachable ?? false,
        reason: r ? r.reason : "unreachable",
      };
    })
    .sort(compareNodes);
}
