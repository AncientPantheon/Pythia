import type { Context, Next } from "hono";
import { OPERATIONAL_PATH, CONSUMER_HEADER } from "../../stats/middleware.js";
import type { EphemeralKeyStore } from "./ephemeralKeyStore.js";
import type { ConnectorStore } from "../store.js";

/**
 * Hono middleware that enforces `docs/work/pythia-connector-protocol/design.md`
 * Decision 1 ("gate access") on the operational `/{chain}/{read|send|poll}`
 * routes — the same path set `statsMiddleware` attributes usage against,
 * reusing its exported `OPERATIONAL_PATH` regex rather than duplicating it.
 *
 * A valid `x-pythia-key` can come from EITHER of two independent stores —
 * both are checked, and a match in either is accepted:
 *   - `EphemeralKeyStore`: the new, short-lived (`pk_eph_...`) secrets minted
 *     by the headless connector-auth round trip this topic adds.
 *   - `ConnectorStore`: the PRE-EXISTING, permanent (`pk_live_...`) keys an
 *     ancient admin mints via `/admin/connectors` — these predate this gate
 *     entirely and must keep working; checking only the ephemeral store here
 *     would silently 401 every already-registered connector.
 *
 * No `x-pythia-key` header at all falls through unchanged (today's open/
 * "direct" behavior, no regression). A header that IS present but resolves in
 * NEITHER store — unknown, expired, malformed — is rejected with 401: a
 * caller actively claiming an identity that doesn't check out is treated
 * differently than an anonymous caller.
 */
export function connectorGateMiddleware(ephemeralStore: EphemeralKeyStore, connectorStore: ConnectorStore) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    if (OPERATIONAL_PATH.exec(c.req.path) === null) {
      await next();
      return;
    }

    const key = c.req.header(CONSUMER_HEADER);
    if (key === undefined) {
      await next();
      return;
    }

    const resolved = ephemeralStore.resolve(key) !== null || connectorStore.nameForKey(key) !== undefined;
    if (!resolved) {
      return c.json({ error: "invalid or expired connector key" }, 401);
    }

    await next();
  };
}
