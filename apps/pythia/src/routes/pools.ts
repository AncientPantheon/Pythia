import type { Hono } from "hono";
import type { NodePool } from "../pool/nodePool.js";
import type { TxSenderStore } from "../txsenders/store.js";

export interface PoolsDeps {
  pool: NodePool;
  txSenders: TxSenderStore;
}

/**
 * Register `GET /api/pools` — a PUBLIC summary of the two pools for the landing
 * page. Deliberately exposes only **sizes + the public seed nodes**: the
 * Observation Pool's node count + feed health, and the Upload Pool's enabled
 * count + its seed nodes (which are already public config). It never leaks the
 * URLs of admin-added Upload senders or individual hub slots.
 */
export function registerPools(app: Hono, deps: PoolsDeps): void {
  app.get("/api/pools", (c) => {
    const health = deps.pool.feedHealth();
    const senders = deps.txSenders.list();
    const seeds = senders
      .filter((s) => s.seed)
      .map((s) => ({ label: s.label, url: s.url, enabled: s.enabled }));
    const enabledCount = senders.filter((s) => s.enabled).length;
    return c.json({
      observation: {
        configured: health.configured,
        ok: health.configured && health.ok,
        count: health.slots,
      },
      upload: { count: enabledCount, seeds },
    });
  });
}
