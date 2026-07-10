import {
  assertChainId,
  dial,
  STOA_NETWORK,
  type FetchImpl,
  type DialNode,
} from "../dial/index.js";
import { readJson } from "./readJson.js";

export interface PollInput {
  /** The request keys to resolve. Must be a non-empty array. */
  requestKeys: string[];
  /** Chainweb chain the txs live on (0-9, default 0). */
  chainId?: number;
  /** Confirmation depth at which a tx is considered final (from config). */
  finalityDepth: number;
}

export interface PollDeps {
  primary: DialNode;
  fallback: DialNode;
  fetchImpl?: FetchImpl;
}

/** Per-request-key confirmation status. `blockHeight` is present once mined. */
export interface PollKeyResult {
  status: "pending" | "final";
  depth: number;
  blockHeight?: number;
}

export interface PollResults {
  chainId: number;
  finalityDepth: number;
  results: Record<string, PollKeyResult>;
}

function pollPath(host: string, chainId: number): string {
  return `${host}/chainweb/0.0/${STOA_NETWORK}/chain/${chainId}/pact/api/v1/poll`;
}

function cutPath(host: string): string {
  return `${host}/chainweb/0.0/${STOA_NETWORK}/cut`;
}

/** Shape of the chainweb poll response: request-key-keyed inclusion records. */
type PollResponse = Record<string, { blockHeight?: number } | undefined>;

/** Shape of the chainweb cut response we read the per-chain height from. */
interface CutResponse {
  hashes?: Record<string, { height?: number } | undefined>;
}

/**
 * POST the chainweb poll read for a batch of request keys over the shared
 * dial(). Returns the raw keyed record so the caller can look up each key's
 * inclusion block height; keys the node did not include (unmined) are simply
 * absent from the record. This is a plain fetch over Pythia's own failover loop
 * — it never touches any broadcast/signing client.
 */
async function pollKeys(
  requestKeys: string[],
  chainId: number,
  deps: PollDeps,
): Promise<PollResponse> {
  const response = await dial(
    {
      chainId,
      buildRequest: (host) => [
        pollPath(host, chainId),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestKeys }),
        },
      ],
    },
    { primary: deps.primary, fallback: deps.fallback, fetchImpl: deps.fetchImpl },
  );

  return (await readJson(
    response,
    pollPath(deps.primary.url, chainId),
  )) as PollResponse;
}

/** Read the current height of `chainId` from the chainweb cut over dial(). */
async function currentHeight(chainId: number, deps: PollDeps): Promise<number> {
  const response = await dial(
    {
      chainId,
      buildRequest: (host) => [cutPath(host), { method: "GET" }],
    },
    { primary: deps.primary, fallback: deps.fallback, fetchImpl: deps.fetchImpl },
  );

  const cut = (await readJson(response, cutPath(deps.primary.url))) as CutResponse;
  return cut.hashes?.[String(chainId)]?.height ?? 0;
}

/**
 * Resolve the confirmation status of a batch of request keys over Pythia's own
 * dial() failover loop. Two plain reads — the chainweb poll (for each key's
 * inclusion block height) and the cut (for the current chain height) — yield,
 * per key, `depth = currentHeight − txBlockHeight` (clamped at 0). A key is
 * `"final"` when `depth >= finalityDepth`, else `"pending"`. An unmined key
 * (absent from the poll result) is a legitimate `pending` at depth 0, not an
 * error. A both-hosts-down read on either fetch propagates
 * PythiaPoolExhaustedError from dial(). `chainId` is validated (0-9, default 0)
 * — the caller validates the non-empty `requestKeys` array BEFORE calling.
 */
export async function pollConfirmations(
  input: PollInput,
  deps: PollDeps,
): Promise<PollResults> {
  const chainId = assertChainId(input.chainId);

  const [keyed, height] = await Promise.all([
    pollKeys(input.requestKeys, chainId, deps),
    currentHeight(chainId, deps),
  ]);

  const results: Record<string, PollKeyResult> = {};
  for (const key of input.requestKeys) {
    const txBlockHeight = keyed[key]?.blockHeight;
    const depth =
      txBlockHeight === undefined ? 0 : Math.max(0, height - txBlockHeight);
    const status = depth >= input.finalityDepth ? "final" : "pending";
    const keyResult: PollKeyResult = { status, depth };
    if (txBlockHeight !== undefined) {
      keyResult.blockHeight = txBlockHeight;
    }
    results[key] = keyResult;
  }

  return { chainId, finalityDepth: input.finalityDepth, results };
}
