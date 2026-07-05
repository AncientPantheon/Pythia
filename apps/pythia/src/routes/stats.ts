import type { Hono } from "hono";
import type { StatsStore } from "../stats/store.js";

/**
 * Register `GET /stats` — the public usage-analytics view. Returns the store's
 * computed aggregates verbatim: totals (per verb + errors), per-chain and
 * per-consumer splits, and a gap-filled ascending daily series (since..today,
 * capped to 90 days). No auth — this is a read-only, aggregate-only view; the
 * per-consumer breakdown could be gated behind a key later if the name list
 * becomes sensitive. Keyless: it counts and reports, it never signs.
 */
export function registerStats(app: Hono, store: StatsStore): void {
  app.get("/stats", (c) => c.json(store.views(), 200));
}
