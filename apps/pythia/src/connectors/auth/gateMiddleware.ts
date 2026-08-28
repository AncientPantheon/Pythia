import type { Context, Next } from "hono";
import { OPERATIONAL_PATH } from "../../stats/middleware.js";
import type { ReadConsumerResolver } from "../../stats/consumerResolver.js";
import { effectiveKey } from "./effectiveKey.js";

/**
 * Hono middleware that gates the operational `/{chain}/{send|poll}` routes
 * (see `docs/work/read-gate-self-key/design.md` + `docs/work/public-dirty-read/`): the
 * WRITE/relay lane is served only if the request resolves to a recognized consumer — a
 * real ephemeral/permanent/env key, or Pythia's own self secret (injected server-side for
 * same-origin reads, see `effectiveKey.ts`).
 *
 * READS are DELIBERATELY EXEMPT — `/{chain}/read` is a keyless PUBLIC utility: a Pact
 * `/local` dirty read (free, no gas, no state change) that any agent/explorer may use to
 * query chain + table data without a connector key. It is still metered (a keyless read →
 * the `"direct"`/"public" bucket, counted, never earning), just never GATED. Only `send`
 * (the metered, earning broadcast) and its `poll` status require a key.
 *
 * Rejection rule (send/poll): resolve the request's EFFECTIVE key through the shared
 * consumer resolver; if it lands in the `"direct"` bucket (no key, or a key that matched
 * NOTHING — unknown/expired), reject with 401.
 *
 * Non-operational paths (health, static, connectors, /api/*) pass through untouched.
 */
export function connectorGateMiddleware(resolveConsumer: ReadConsumerResolver) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const match = OPERATIONAL_PATH.exec(c.req.path);
    if (match === null) {
      await next();
      return;
    }
    // The dirty-read lane is a keyless public utility — never gated (only send/poll are).
    if (match[2] === "read") {
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
