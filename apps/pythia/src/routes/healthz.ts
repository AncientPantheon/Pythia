import type { Hono } from "hono";
import { loadConfigFromDisk, type PythiaConfig } from "../config/index.js";
import { resolveHealth, type HealthSnapshot } from "../health/index.js";
import { STOA_NETWORK, type DialNode } from "../dial/index.js";
import { PYTHIA_VERSION } from "../version.js";

/** The automaton's own capability flags — is Pythia LIVE and working as an
 * automaton (its autonomous machinery up + its own API link online), distinct
 * from StoaChain read-source reachability. Each flag is a truthful runtime read;
 * the composition root supplies them (this request-path module never imports the
 * automaton core — it just relays the flags the root computes). */
export interface AutomatonCapabilities {
  /** The Khronoton tick loop is running (the autonomous engine ticks). */
  khronotonTick: boolean;
  /** Both autonomous server resolvers are registered: `dual-link-activate` (fires
   * `A_LinkDualApiKey`) and `pyth-flush` — the activation pipeline is wired. */
  activationPipeline: boolean;
  /** Pythia's OWN dual API link (self-connector) is active — its identity is online. */
  selfConnectorLinked: boolean;
  /** Count of registered + enabled verifier entities (0 is valid — none added yet). */
  verifiersRegistered: number;
}

export interface HealthzDeps {
  /** Resolve the current health snapshot. Injectable so tests avoid the network;
   * defaults to the production resolver over real fetch + config-resolved sources. */
  resolve?: () => Promise<HealthSnapshot>;
  /** The live read pool. When present, /healthz checks the nodes ACTUALLY serving
   * reads (a rotating hub pair, or the Upload Pool) instead of only the config
   * seed pair — so the routing tri-state can't contradict the real read path. It
   * falls back to the seed pair when the pool has no nodes to offer. */
  pool?: { pickReadPair(): { primary: DialNode; fallback: DialNode } | null };
  /** Read the automaton capability flags at request time. Omitted → the `automaton`
   * block is absent from the response (pre-liveness shape). Supplied by the
   * composition root, which alone may read the automaton core. */
  capabilities?: () => AutomatonCapabilities;
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
    const caps = deps.capabilities?.();
    // "live" (the green check) = the automaton's autonomous machinery is up AND
    // its own API link is online. verifiersRegistered is a readiness signal for
    // onboarding OTHERS, not a self-liveness gate, so it doesn't factor in here.
    const automaton = caps
      ? {
          live: caps.khronotonTick && caps.activationPipeline && caps.selfConnectorLinked,
          ...caps,
        }
      : undefined;
    return c.json(
      {
        service: "ok",
        version: PYTHIA_VERSION,
        active: snapshot.active,
        routing: snapshot.routing,
        sources: snapshot.sources,
        ...(automaton ? { automaton } : {}),
      },
      200,
    );
  });
}
