import { DUAL_LINK_ACTIVATE_RESOLVER } from "./dualLinkActivateResolver.js";
import { PYTH_FLUSH_RESOLVER } from "./pythFlushResolver.js";

/**
 * Which server-resolver names are EVENT-DRIVEN — their cronoton is fired by an
 * in-process event (e.g. the link event that fires `dual-link-activate`), NEVER
 * by a schedule. Picking one of these in the cronoton builder must turn scheduling
 * OFF: the cronoton is forced scheduleless (`externalFireable`) at commit, so
 * khronoton-core stores `next_fire_at = NULL` and the tick's `next_fire_at IS NOT
 * NULL` due-query skips it entirely.
 *
 * khronoton-core has no notion of an "evented" resolver (its resolver type carries
 * only `kind`), so this fact lives HERE, in the consumer that registers the
 * resolvers and knows which are event-triggered. `pyth-flush` is deliberately NOT
 * evented — it IS schedule-driven (a daily flush) and keeps its schedule.
 */
export const EVENTED_SERVER_RESOLVERS: ReadonlySet<string> = new Set<string>([
  DUAL_LINK_ACTIVATE_RESOLVER,
]);

// Referenced so the schedule-driven resolver is explicitly documented as NON-evented
// (and a future addition to the evented set is a deliberate, visible edit here).
void PYTH_FLUSH_RESOLVER;

/** Whether a server-resolver name is event-driven (scheduleless by construction). */
export function isEventedResolver(name: unknown): boolean {
  return typeof name === "string" && EVENTED_SERVER_RESOLVERS.has(name);
}

/**
 * Enforce "picking an evented resolver turns scheduling off" on a cronoton COMMIT
 * body: if the body's `envelope.serverResolver` is event-driven, force
 * `envelope.externalFireable = true` (khronoton-core then stores the row
 * scheduleless — `next_fire_at = NULL`). Mutates and returns the body; a
 * non-object body, a body without an evented resolver, passes through untouched.
 *
 * This is the SERVER-SIDE guarantee: regardless of what the builder UI sends (even
 * a schedule), an evented-resolver cronoton is always committed scheduleless — it
 * can't be misconfigured to auto-tick and double-fire alongside the event.
 */
export function enforceEventedScheduleless(body: unknown): unknown {
  if (body && typeof body === "object") {
    const env = (body as { envelope?: unknown }).envelope;
    if (env && typeof env === "object") {
      const e = env as { serverResolver?: unknown; externalFireable?: unknown };
      if (isEventedResolver(e.serverResolver)) {
        e.externalFireable = true;
      }
    }
  }
  return body;
}
