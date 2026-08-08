import type { Context, Next } from "hono";
import { OPERATIONAL_PATH, CONSUMER_HEADER } from "../../stats/operational.js";

/**
 * The read-gate + self-key seam (see `docs/work/read-gate-self-key/design.md`).
 *
 * A request's EFFECTIVE key is what the gate + meters attribute and gate it by:
 *   1. an explicit `x-pythia-key` header (a real consumer), else
 *   2. a server-INJECTED key set by {@link firstPartyKeyMiddleware} — Pythia's own
 *      self secret, applied to same-origin (first-party) reads so her website's
 *      keyless fetches resolve to `pythia-self` and pass the hardened gate, without
 *      the secret ever reaching the browser.
 *
 * The injected value rides a Hono context var (the same `c.set`/`c.get` seam already
 * used for `servedSlotId`/`adminSession`) rather than a forged header, so the
 * original request headers stay untouched.
 */
export const INJECTED_KEY_VAR = "pythiaKey";

/** The key a request should be attributed + gated by — header first, else injected. */
export function effectiveKey(c: Context): string | undefined {
  const header = c.req.header(CONSUMER_HEADER);
  if (header !== undefined && header !== "") return header;
  const injected = c.get(INJECTED_KEY_VAR);
  return typeof injected === "string" && injected !== "" ? injected : undefined;
}

/**
 * First-party iff the browser marks the fetch same-origin. `Sec-Fetch-Site` is set
 * by the browser and CANNOT be overridden by cross-site page script, so a malicious
 * third-party site can't make a visitor's browser issue a `same-origin`-labelled
 * read to Pythia. (A non-browser client CAN forge it — accepted: the blast radius is
 * only public chain reads attributed to Pythia's own bucket; see the design's
 * security note.)
 */
export function isFirstParty(c: Context): boolean {
  return c.req.header("sec-fetch-site") === "same-origin";
}

/**
 * Middleware: for an OPERATIONAL request (`/{chain}/{read|send|poll}`) that carries
 * NO `x-pythia-key` and is first-party (same-origin), inject an effective key so her
 * website's keyless reads attribute to `pythia-self` and clear the gate:
 *   - Pythia's own self secret when she has one (→ `pythia-self`, KEYED/earning), else
 *   - the `firstPartyMarker` — a RANDOM per-process token (see index.ts) that the
 *     resolver maps to `pythia-self` UNKEYED. This keeps her own site fully readable
 *     even in the windows where the self secret is briefly absent (e.g. just after a
 *     deploy, before the self-connector re-mints) — without those reads ever going
 *     anonymous or 401. The marker is never sent to any client and is unguessable, so
 *     an external caller cannot present it to masquerade as `pythia-self`.
 * Everything else is left alone: an external/server-to-server caller with no key gets
 * nothing injected and is rejected downstream by the gate.
 */
export function firstPartyKeyMiddleware(
  selfSecret: () => string | null | undefined,
  firstPartyMarker: string,
) {
  return async (c: Context, next: Next): Promise<void> => {
    if (
      OPERATIONAL_PATH.exec(c.req.path) !== null &&
      c.req.header(CONSUMER_HEADER) === undefined &&
      isFirstParty(c)
    ) {
      c.set(INJECTED_KEY_VAR, selfSecret() || firstPartyMarker);
    }
    await next();
  };
}
