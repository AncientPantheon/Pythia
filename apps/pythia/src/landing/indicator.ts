import type { SourceHealth, Routing } from "../health/index.js";

/** The four presentational states a source dot can take on the landing page. */
export type IndicatorColor = "green" | "amber" | "red" | "grey";

/**
 * Derive a single source's indicator color from its reachability and the
 * service's active-routing tri-state. Mirrors the OuronetUI NodeHealthBadge
 * table client-side:
 *
 *   - unreachable source            -> red   (failed its /info ping)
 *   - reachable + routing=fallback  -> amber (degraded — this is the live fallback)
 *   - reachable otherwise           -> green (healthy: nominal primary or idle standby)
 *
 * The grey "checking" state has no snapshot to derive from and is produced by
 * {@link pendingIndicator} before the first poll lands.
 */
export function sourceIndicator(
  source: SourceHealth,
  routing: Routing,
): Exclude<IndicatorColor, "grey"> {
  if (!source.reachable) return "red";
  if (routing === "fallback") return "amber";
  return "green";
}

/**
 * The pre-first-poll indicator: grey "checking" while no `/healthz` snapshot has
 * arrived yet. Avoids a red flash on every page load (mirrors the badge's
 * `isAlive === null` grey).
 */
export function pendingIndicator(): Extract<IndicatorColor, "grey"> {
  return "grey";
}
