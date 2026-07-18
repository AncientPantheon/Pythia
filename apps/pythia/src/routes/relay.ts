import type { Context } from "hono";
import {
  PythiaPoolExhaustedError,
  PythiaValidationError,
  type FetchImpl,
  type DialNode,
} from "../dial/index.js";
import { PythiaUpstreamError } from "../reads/index.js";
import { loadConfigFromDisk, type SourceConfig } from "../config/index.js";
import type { NodePool } from "../pool/nodePool.js";
import {
  PYTHIA_POOL_EXHAUSTED,
  PYTHIA_UPSTREAM,
  PYTHIA_VALIDATION,
} from "./errorEnvelope.js";

export interface RelayDeps {
  /** Primary + fallback sources. Injectable so tests avoid disk/network;
   * defaults to the config-resolved roles. */
  sources?: { primary: SourceConfig; fallback: SourceConfig };
  /** Injected fetch. Defaults to the global. */
  fetchImpl?: FetchImpl;
  /** The live read-node pool. When present (and no explicit `sources`), READ and
   * POLL draw a rotating {primary, fallback} pair from the hub fleet via
   * {@link resolveReadPair}. SEND deliberately does NOT use it — signed txs go
   * only to the Upload Pool (the dedicated, ancient-managed tx-sender list). */
  pool?: NodePool;
}

/** Maximum relay body size. A signed Pact command is small (well under a KB);
 * 1 MB is a generous ceiling that still rejects a DoS-sized body before it is
 * buffered or forwarded. */
export const MAX_RELAY_BODY_BYTES = 1024 * 1024;

export function resolveSources(deps: RelayDeps): {
  primary: SourceConfig;
  fallback: SourceConfig;
} {
  if (deps.sources) return deps.sources;
  const config = loadConfigFromDisk();
  const primary = config.sources.find((s) => s.role === "primary")!;
  const fallback = config.sources.find((s) => s.role === "fallback")!;
  return { primary, fallback };
}

/**
 * Resolve the {primary, fallback} pair for a READ or POLL. Explicit `sources`
 * (tests) win; otherwise a live {@link NodePool} yields a rotating hub-fleet
 * primary + seed fallback; absent both, it degrades to the seed roles. This is
 * the single seam that enlarges reads across the hub fleet — the dial itself is
 * unchanged. SEND does NOT call this (it stays on {@link resolveSources}).
 */
export function resolveReadPair(
  deps: RelayDeps,
): { primary: DialNode; fallback: DialNode } | null {
  if (deps.sources) return deps.sources;
  if (deps.pool) return deps.pool.pickReadPair(); // null when no nodes to serve
  return resolveSources(deps);
}

/**
 * Map a thrown transport error to its HTTP response. A typed input error → 400;
 * a fully-exhausted pool → 502 carrying the per-source failures; an
 * arrived-but-undecodable node response → a client 400 when the node rejected
 * the caller's input (upstream 4xx) or a 502 "upstream error" for an upstream
 * 5xx / non-JSON body. Anything else is re-thrown to the framework.
 */
export function respondRelayError(c: Context, err: unknown): Response {
  if (err instanceof PythiaValidationError) {
    return c.json({ code: PYTHIA_VALIDATION, error: err.message }, 400);
  }
  if (err instanceof PythiaUpstreamError) {
    if (err.status >= 400 && err.status < 500) {
      return c.json(
        {
          code: PYTHIA_UPSTREAM,
          error: `upstream rejected request: ${err.message}`,
        },
        400,
      );
    }
    return c.json({ code: PYTHIA_UPSTREAM, error: "upstream error" }, 502);
  }
  if (err instanceof PythiaPoolExhaustedError) {
    return c.json(
      {
        code: PYTHIA_POOL_EXHAUSTED,
        error: "PythiaPoolExhaustedError",
        chainId: err.chainId,
        failures: err.failures.map((f) => ({
          sourceId: f.sourceId,
          url: f.url,
          cause: String(f.cause instanceof Error ? f.cause.message : f.cause),
        })),
      },
      502,
    );
  }
  throw err;
}

/** Read a dialed node response and return it to the caller VERBATIM — same
 * status, same body, same content-type. The keyless relay never decodes or
 * reshapes a node payload. */
export async function passthrough(response: Response): Promise<Response> {
  const text = await response.text();
  return new Response(text, {
    status: response.status,
    headers: {
      "content-type":
        response.headers.get("content-type") ?? "application/json",
    },
  });
}
