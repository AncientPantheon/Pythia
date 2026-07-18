import type { Hono } from "hono";
import { loadConfigFromDisk, type PythiaConfig } from "../config/index.js";
import { resolveHealth, type HealthSnapshot } from "../health/index.js";
import { STOA_NETWORK, type DialNode } from "../dial/index.js";
import { PYTHIA_VERSION } from "../version.js";

export interface HealthzDeps {
  /** Resolve the current health snapshot. Injectable so tests avoid the network;
   * defaults to the production resolver over real fetch + config-resolved sources. */
  resolve?: () => Promise<HealthSnapshot>;
  /** The live read pool. When present, /healthz checks the nodes ACTUALLY serving
   * reads (a rotating hub pair, or the Upload Pool) instead of only the config
   * seed pair — so the routing tri-state can't contradict the real read path. It
   * falls back to the seed pair when the pool has no nodes to offer. */
  pool?: { pickReadPair(): { primary: DialNode; fallback: DialNode } | null };
}

function seedResolve(): Promise<HealthSnapshot> {
  const config: PythiaConfig = loadConfigFromDisk();
  const primary = config.sources.find((s) => s.role === "primary")!;
  const fallback = config.sources.find((s) => s.role === "fallback")!;
  return resolveHealth({ primary, fallback });
}

/**
 * Register `GET /healthz`. Returns service liveness + the derived active-routing
 * tri-state + each source's individual reachability. Always HTTP 200 while the
 * service answers — source health lives in the body, not the status — and never
 * fails over or throws the pool-exhausted error.
 */
export function registerHealthz(app: Hono, deps: HealthzDeps = {}): void {
  const resolve =
    deps.resolve ??
    (() => {
      // Prefer the live read pair (pool-aware); fall back to the seed pair when the
      // pool has nothing to offer, or when no pool was wired. resolveHealth wants
      // SourceConfig (role/chain); the pool yields bare DialNodes, so tag them.
      const pair = deps.pool?.pickReadPair();
      if (!pair) return seedResolve();
      return resolveHealth({
        primary: { ...pair.primary, role: "primary", chain: STOA_NETWORK },
        fallback: { ...pair.fallback, role: "fallback", chain: STOA_NETWORK },
      });
    });

  app.get("/healthz", async (c) => {
    const snapshot = await resolve();
    return c.json(
      {
        service: "ok",
        version: PYTHIA_VERSION,
        active: snapshot.active,
        routing: snapshot.routing,
        sources: snapshot.sources,
      },
      200,
    );
  });
}
