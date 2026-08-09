import type { Context, Next } from "hono";
import { OPERATIONAL_PATH } from "../../stats/middleware.js";
import type { ReadConsumerResolver } from "../../stats/consumerResolver.js";
import { effectiveKey } from "./effectiveKey.js";

/**
 * Hono middleware that HARD-GATES the operational `/{chain}/{read|send|poll}` routes
 * (see `docs/work/read-gate-self-key/design.md`): a request is served only if it
 * resolves to a recognized consumer — a real ephemeral/permanent/env key, or Pythia's
 * own self secret (injected server-side for same-origin reads, see `effectiveKey.ts`).
 *
 * Rejection rule: resolve the request's EFFECTIVE key through the shared consumer
 * resolver; if it lands in the `"direct"` bucket (no key at all, or a key that matched
 * NOTHING — unknown/expired), reject with 401. This unifies the gate with attribution:
 * `"direct"` is precisely the unrecognized/anonymous case, and nothing that resolves to
 * a real consumer is ever `"direct"`.
 *
 * This closes the old hole where a keyless caller fell straight through (served + mislabelled
 * `pythia-self`). It must run BEFORE `statsMiddleware`/`pythMeterMiddleware`, so a rejected
 * request is NOT metered — the `"direct"`/"Anonymous" bucket can no longer reappear.
 *
 * Non-operational paths (health, static, connectors, /api/*) pass through untouched.
 */
export function connectorGateMiddleware(resolveConsumer: ReadConsumerResolver) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    if (OPERATIONAL_PATH.exec(c.req.path) === null) {
      await next();
      return;
    }

    const key = effectiveKey(c);
    const { consumer } = resolveConsumer(key);
    if (consumer === "direct") {
      // A PRESENTED-but-unresolvable key (unknown/expired/orphaned) must return the EXACT
      // string the client SDK's 401 self-heal matches ("invalid or expired connector key",
      // `transport.ts` INVALID_KEY_ERROR) — so a refreshable `asKeySource()` key
      // invalidates → re-mints → retries once, instead of getting stuck on a dead key.
      // A request with NO key at all has nothing to self-heal → the plain "need a key".
      return key
        ? c.json({ error: "invalid or expired connector key" }, 401)
        : c.json({ error: "a valid connector API key is required" }, 401);
    }

    await next();
  };
}
