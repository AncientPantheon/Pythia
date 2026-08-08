/**
 * The two request-path constants shared by the stats/pyth meters, the connector gate,
 * and the effective-key seam. Extracted into their own leaf module so `effectiveKey.ts`
 * can use them WITHOUT importing `middleware.ts` (which imports `effectiveKey.ts` back) —
 * i.e. to break what would otherwise be a `middleware ↔ effectiveKey` import cycle.
 * `middleware.ts` re-exports both, so existing `from "./middleware.js"` importers are
 * unaffected.
 */

/** Only the three operational verbs are counted/gated — `/{chain}/{read|send|poll}`.
 * Health, connectors, `/api/*`, and static assets deliberately do NOT match. */
export const OPERATIONAL_PATH = /^\/([^/]+)\/(read|send|poll)$/;

/** Header a consumer sends to identify itself for usage attribution + gating. */
export const CONSUMER_HEADER = "x-pythia-key";
