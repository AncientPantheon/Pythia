import type { FetchImpl } from "../dial/index.js";
import { HEALTH_TIMEOUT_MS } from "./resolver.js";

/**
 * Per-node reachability, from Pythia's own vantage — the exact contract the hub
 * node feed must satisfy (see docs/HANDOFF-hub-node-feed-reachability.md): a live
 * `GET <url>/info` over HTTPS, 3s timeout, 2xx required, TLS certificate validated.
 * When it fails, `reason` says WHY so a red dot in the admin is diagnosable rather
 * than opaque.
 */

export interface NodeReachability {
  url: string;
  reachable: boolean;
  /** `null` when reachable; else why it failed. */
  reason: NodeReachabilityReason | null;
}

export type NodeReachabilityReason =
  | "refused" // ECONNREFUSED — nothing listening on that port
  | "timeout" // the probe aborted (host/port not answering in time)
  | "dns" // ENOTFOUND / EAI_AGAIN — the host name doesn't resolve
  | "cert" // TLS certificate rejected (mismatch, expired, self-signed)
  | "unreachable" // some other connection-level failure
  | `http ${number}`; // connected, but a non-2xx status

export interface ProbeNodesOpts {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

/** Node's TLS error codes surface on `err.cause.code`; map the common ones to "cert". */
const CERT_CODES = new Set([
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_FORMAT",
  "ERR_SSL_WRONG_VERSION_NUMBER",
]);

function causeCode(err: unknown): string | undefined {
  const cause = (err as { cause?: { code?: unknown } })?.cause;
  return typeof cause?.code === "string" ? cause.code : undefined;
}

function classify(err: unknown): NodeReachabilityReason {
  // The abort rejects with a DOMException in Node — which is NOT `instanceof Error`
  // — so match the name by duck-typing, not the class.
  if ((err as { name?: string })?.name === "AbortError") return "timeout";
  const code = causeCode(err);
  if (code === "ECONNREFUSED") return "refused";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "timeout";
  if (code && CERT_CODES.has(code)) return "cert";
  return "unreachable";
}

async function probeOne(
  url: string,
  fetchImpl: FetchImpl,
  timeoutMs: number,
): Promise<NodeReachability> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // `redirect: "manual"` — a reachability probe wants the node to serve /info
    // directly; it must not be bounced (a compromised feed could redirect the
    // probe elsewhere, and a 3xx isn't "reachable" for our purposes anyway).
    const res = await fetchImpl(`${url}/info`, {
      signal: controller.signal,
      redirect: "manual",
    });
    if (res.ok) return { url, reachable: true, reason: null };
    return { url, reachable: false, reason: `http ${res.status}` };
  } catch (err) {
    // The deadline firing is definitive regardless of the thrown error's shape.
    const reason = controller.signal.aborted ? "timeout" : classify(err);
    return { url, reachable: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe every url in parallel; returns one {@link NodeReachability} per input, in
 * input order. Never throws — a failed probe becomes an unreachable result.
 */
export function probeNodes(
  urls: string[],
  opts: ProbeNodesOpts = {},
): Promise<NodeReachability[]> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchImpl);
  const timeoutMs = opts.timeoutMs ?? HEALTH_TIMEOUT_MS;
  return Promise.all(urls.map((u) => probeOne(u, fetchImpl, timeoutMs)));
}
