import type { Context, Next } from "hono";
import type { StatsEndpoint, StatsStore } from "./store.js";
import { OPERATIONAL_PATH, CONSUMER_HEADER } from "./operational.js";
import { effectiveKey } from "../connectors/auth/effectiveKey.js";

/** Resolve a request's `x-pythia-key` to a consumer name (or the "direct"
 * anonymous bucket). Injected so the source — env map, connector store, or both —
 * is decided at wiring time. */
export type ConsumerResolver = (key?: string) => string;

// Re-exported from ./operational.js (the leaf module that also feeds effectiveKey.ts,
// breaking the middleware↔effectiveKey cycle) so existing `from "./middleware.js"`
// importers of these two constants keep working unchanged.
export { OPERATIONAL_PATH, CONSUMER_HEADER };

/**
 * Hono middleware that records usage analytics for operational requests.
 *
 * It matches the request path against `/{chain}/{read|send|poll}` — anything
 * else (health, static, connectors) passes through unrecorded so the 15s health
 * polling does not swamp real usage. For a match it resolves the consumer from
 * the `x-pythia-key` header, runs the handler, then records one aggregate bucket
 * keyed by day/consumer/chain/endpoint/ok. Keyless-safe: it only counts and
 * never signs or broadcasts.
 */
export function statsMiddleware(
  store: StatsStore,
  resolveConsumer: ConsumerResolver,
) {
  return async (c: Context, next: Next): Promise<void> => {
    const match = OPERATIONAL_PATH.exec(c.req.path);
    if (match === null) {
      await next();
      return;
    }

    const chain = match[1];
    const endpoint = match[2] as StatsEndpoint;
    const consumer = resolveConsumer(effectiveKey(c));

    await next();

    store.record({
      consumer,
      chain,
      endpoint,
      ok: c.res.status < 400,
      day: store.today(),
    });
  };
}
