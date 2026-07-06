import type { Hono } from "hono";
import { loadConfigFromDisk, type PythiaConfig } from "../config/index.js";
import { resolveHealth, type HealthSnapshot } from "../health/index.js";
import { PYTHIA_VERSION } from "../version.js";

export interface HealthzDeps {
  /** Resolve the current health snapshot. Injectable so tests avoid the network;
   * defaults to the production resolver over real fetch + config-resolved sources. */
  resolve?: () => Promise<HealthSnapshot>;
}

function defaultResolve(): Promise<HealthSnapshot> {
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
  const resolve = deps.resolve ?? defaultResolve;

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
