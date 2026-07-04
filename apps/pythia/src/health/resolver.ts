import type { SourceConfig } from "../config/index.js";
import type { FetchImpl } from "../dial/index.js";

/** Default cadence of the background health poll (mirrors useNodeHealth 15s). */
export const POLL_INTERVAL_MS = 15_000;
/** Default per-check /info liveness timeout (mirrors useNodeHealth 3s). */
export const HEALTH_TIMEOUT_MS = 3_000;

/** The derived active-routing tri-state — the single field the landing page
 * maps to green/amber/red. */
export type Routing = "primary" | "fallback" | "unreachable";

export interface SourceHealth {
  id: string;
  url: string;
  role: SourceConfig["role"];
  reachable: boolean;
}

export interface HealthSnapshot {
  active: { sourceId: string; url: string };
  routing: Routing;
  sources: SourceHealth[];
}

export interface ResolveHealthDeps {
  primary: SourceConfig;
  fallback: SourceConfig;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

/**
 * Ping a single source's `/info` liveness endpoint with a per-check timeout.
 * Returns `true` only on an arrived 2xx response; any rejection (network error,
 * abort/timeout) or non-ok status is `false`. Mirrors `useNodeHealth.pingHealth`.
 */
async function pingInfo(
  hostUrl: string,
  fetchImpl: FetchImpl,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${hostUrl}/info`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a full health snapshot: each source's individual `/info` reachability
 * plus the derived active-routing tri-state. GREEN when the primary is up
 * (routing=primary), AMBER when the primary is down but the fallback is up
 * (routing=fallback), RED when neither is up (routing=unreachable). Never
 * throws the pool-exhausted error — it reports, it does not route.
 */
export async function resolveHealth(
  deps: ResolveHealthDeps,
): Promise<HealthSnapshot> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchImpl);
  const timeoutMs = deps.timeoutMs ?? HEALTH_TIMEOUT_MS;

  const [primaryOk, fallbackOk] = await Promise.all([
    pingInfo(deps.primary.url, fetchImpl, timeoutMs),
    pingInfo(deps.fallback.url, fetchImpl, timeoutMs),
  ]);

  const sources: SourceHealth[] = [
    {
      id: deps.primary.id,
      url: deps.primary.url,
      role: deps.primary.role,
      reachable: primaryOk,
    },
    {
      id: deps.fallback.id,
      url: deps.fallback.url,
      role: deps.fallback.role,
      reachable: fallbackOk,
    },
  ];

  let routing: Routing;
  let active: { sourceId: string; url: string };
  if (primaryOk) {
    routing = "primary";
    active = { sourceId: deps.primary.id, url: deps.primary.url };
  } else if (fallbackOk) {
    routing = "fallback";
    active = { sourceId: deps.fallback.id, url: deps.fallback.url };
  } else {
    routing = "unreachable";
    // No live host; report the primary as the nominal active for display.
    active = { sourceId: deps.primary.id, url: deps.primary.url };
  }

  return { active, routing, sources };
}

export interface PollerOptions {
  intervalMs?: number;
  onSnapshot: (snapshot: HealthSnapshot) => void;
}

/**
 * Start a background poller that resolves health immediately on start, then on
 * a fixed interval, invoking `onSnapshot` with each snapshot. Returns a stop
 * function that clears the interval. The interval timer is unref'd so it never
 * keeps the Node event loop alive on its own.
 */
export function startHealthPoller(
  deps: ResolveHealthDeps,
  options: PollerOptions,
): () => void {
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;

  const poll = () => {
    void resolveHealth(deps).then(options.onSnapshot);
  };

  poll();
  const timer = setInterval(poll, intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}
