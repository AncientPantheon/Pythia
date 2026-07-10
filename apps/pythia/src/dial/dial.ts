import type { SourceConfig } from "../config/index.js";
import { PythiaPoolExhaustedError, type SourceFailure } from "./errors.js";

/** The Stoa network segment and chain count, kept as LOCAL literals so no line
 * of Pythia transport ever imports `@stoachain/stoa-core/network`. Mirrors the
 * sibling's `KADENA_NETWORK="stoa"` / `STOA_CHAIN_COUNT=10`. */
export const STOA_NETWORK = "stoa";
export const CHAIN_COUNT = 10;

/**
 * Default per-attempt timeout (ms) applied to every dial fetch. A node that
 * accepts the connection then hangs is neither a rejection nor an arrival, so
 * without a timeout the request — and Pythia with it — hangs forever AND
 * failover never fires. Aborting a hung attempt turns it into an AbortError,
 * which {@link isTransportFailure} treats as a transport failure so the fallback
 * is tried. 10s is generous for a /local read yet bounds the worst case.
 */
export const DEFAULT_DIAL_TIMEOUT_MS = 10_000;

/** The injected fetch implementation. Defaults to the Node 22 global `fetch`. */
export type FetchImpl = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

/** Build the `[url, init]` fetch arguments for a given host base URL. The
 * caller (relay / health / Phase-3 reads) owns request shaping; the dial owns
 * only host selection and failover. */
export type BuildRequest = (baseHost: string) => [string, RequestInit];

export interface DialRequest {
  buildRequest: BuildRequest;
  /** Carried onto the terminal error for chain-scoped reads/relays. */
  chainId?: number;
}

export interface DialDeps {
  primary: SourceConfig;
  fallback: SourceConfig;
  fetchImpl?: FetchImpl;
  /** Per-attempt abort timeout in ms. Defaults to {@link DEFAULT_DIAL_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Any config sources beyond primary+fallback. Accepted for signature
   * completeness but deliberately never dialled — the pool is two-host only. */
  extras?: SourceConfig[];
}

/**
 * A rejected fetch is a transport failure (network down, DNS, ECONNREFUSED,
 * AbortError/timeout) → the other host is tried. An ARRIVED HTTP response, even
 * a node 4xx/5xx, is NOT a transport failure — it is returned as-is so a
 * node-level Pact error is never masked as a failover event. Mirrors the
 * sibling's `isNetworkError` gate but is Pythia's own code.
 */
function isTransportFailure(err: unknown): boolean {
  if (err instanceof Error) {
    // AbortError: a caller/merged-signal cancellation. TimeoutError: the shape
    // AbortSignal.timeout() rejects a hung attempt with. Both mean the attempt
    // never completed → try the other host.
    if (err.name === "AbortError" || err.name === "TimeoutError") return true;
    const m = err.message;
    if (
      m.includes("Failed to fetch") ||
      m.includes("fetch failed") ||
      m.includes("NetworkError") ||
      m.includes("ECONNREFUSED") ||
      m.includes("ENOTFOUND") ||
      m.includes("EAI_AGAIN")
    ) {
      return true;
    }
    // A TypeError from fetch is the canonical browser/undici network-failure
    // shape even when the message differs across runtimes.
    if (err instanceof TypeError) return true;
  }
  return false;
}

/**
 * Pythia's own two-host primary/fallback failover primitive over plain fetch.
 * Attempts the primary; on a TRANSPORT failure only, retries the fallback
 * exactly once. On an arrived HTTP response (any status) returns it as-is. When
 * both hosts fail transport, throws {@link PythiaPoolExhaustedError} carrying
 * both per-source failures in attempt order (primary then fallback).
 *
 * Two-host only: no quorum, no round-robin, no third host. Any `extras` are
 * inert. This is the single failover loop the relay, the health resolver, and
 * (Phase 3) the reads all share.
 */
export async function dial(
  req: DialRequest,
  deps: DialDeps,
): Promise<Response> {
  return dialNodes(req, {
    nodes: [deps.primary, deps.fallback],
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
  });
}

/** The minimal host shape the dial needs — only `id` (for failure attribution)
 * and `url` (to build the request). `SourceConfig` and hub slots both satisfy it. */
export interface DialNode {
  id: string;
  url: string;
}

export interface DialNodesDeps {
  /** Ordered nodes to try, one after another, until one arrives (transport OK). */
  nodes: DialNode[];
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

/**
 * The N-node sequential failover core: try each node in order; on a TRANSPORT
 * failure only, move to the next; on an arrived HTTP response (any status) return
 * it as-is; when every node fails transport, throw {@link PythiaPoolExhaustedError}
 * with all per-node failures in attempt order. Used directly for the Upload-Pool
 * `/send` lane ("one after the other" across the manual senders); {@link dial} is
 * the two-host `[primary, fallback]` special case over this same loop.
 */
export async function dialNodes(
  req: DialRequest,
  deps: DialNodesDeps,
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchImpl);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS;
  const failures: SourceFailure[] = [];

  for (const node of deps.nodes) {
    const [url, init] = req.buildRequest(node.url);
    // Bound each attempt: on timeout the signal aborts → AbortError →
    // isTransportFailure → the next node is tried. Any caller-supplied signal is
    // merged so neither the caller's cancellation nor the timeout is lost.
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal =
      init.signal != null
        ? AbortSignal.any([init.signal, timeoutSignal])
        : timeoutSignal;
    try {
      return await fetchImpl(url, { ...init, signal });
    } catch (cause) {
      if (!isTransportFailure(cause)) {
        // A non-transport throw (e.g. a programming error in buildRequest) is
        // not a pool-health signal; surface it rather than masking it.
        throw cause;
      }
      failures.push({ sourceId: node.id, url, cause });
    }
  }

  throw new PythiaPoolExhaustedError({ failures, chainId: req.chainId });
}
