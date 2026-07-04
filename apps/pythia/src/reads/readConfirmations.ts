import {
  assertChainId,
  dial,
  STOA_NETWORK,
  type FetchImpl,
} from "../dial/index.js";
import type { SourceConfig } from "../config/index.js";
import { requireNonEmpty } from "./validate.js";
import { readJson } from "./readJson.js";

export interface ReadConfirmationsInput {
  tx: string;
  /** Chainweb chain the tx lives on (0-9, default 0). */
  chainId?: number;
  /** Confirmation depth at which a tx is considered final (from config). */
  finalityDepth: number;
}

export interface ReadConfirmationsDeps {
  primary: SourceConfig;
  fallback: SourceConfig;
  fetchImpl?: FetchImpl;
}

export interface Confirmations {
  chain: "stoachain";
  chainId: number;
  tx: string;
  status: "pending" | "final";
  depth: number;
  finalityDepth: number;
  /** Present once the tx is mined into a block. */
  blockHeight?: number;
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
 * Query the chainweb poll read for a request key over the shared dial(). POSTs
 * `{ requestKeys: [tx] }` and returns the tx's inclusion block height when the
 * result carries one; an empty keyed result (tx not yet mined) returns
 * `undefined`. This is a plain fetch over Pythia's own failover loop — it never
 * touches the sibling's broadcast/read client.
 */
async function pollBlockHeight(
  tx: string,
  chainId: number,
  deps: ReadConfirmationsDeps,
): Promise<number | undefined> {
  const response = await dial(
    {
      chainId,
      buildRequest: (host) => [
        pollPath(host, chainId),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestKeys: [tx] }),
        },
      ],
    },
    { primary: deps.primary, fallback: deps.fallback, fetchImpl: deps.fetchImpl },
  );

  const keyed = (await readJson(
    response,
    pollPath(deps.primary.url, chainId),
  )) as PollResponse;
  const record = keyed[tx];
  return record?.blockHeight;
}

/** Read the current height of `chainId` from the chainweb cut over dial(). */
async function currentHeight(
  chainId: number,
  deps: ReadConfirmationsDeps,
): Promise<number> {
  const response = await dial(
    {
      chainId,
      buildRequest: (host) => [cutPath(host), { method: "GET" }],
    },
    { primary: deps.primary, fallback: deps.fallback, fetchImpl: deps.fetchImpl },
  );

  const cut = (await readJson(
    response,
    cutPath(deps.primary.url),
  )) as CutResponse;
  return cut.hashes?.[String(chainId)]?.height ?? 0;
}

/**
 * Decode a tx's confirmation status over Pythia's own dial() failover loop. Two
 * plain reads — the chainweb poll (for the tx's inclusion block height) and the
 * cut (for the current chain height) — yield `depth = currentHeight −
 * txBlockHeight` (clamped at 0). `status` is `"final"` when `depth >=
 * finalityDepth`, else `"pending"`. An unmined tx (empty poll result) is a
 * legitimate `pending` at depth 0, not an error. A both-hosts-down read on
 * either fetch propagates PythiaPoolExhaustedError from dial(). `chainId` is
 * validated (0-9, default 0) and an empty `tx` throws PythiaValidationError —
 * both BEFORE any read.
 */
export async function readConfirmations(
  input: ReadConfirmationsInput,
  deps: ReadConfirmationsDeps,
): Promise<Confirmations> {
  const chainId = assertChainId(input.chainId);
  const tx = requireNonEmpty(input.tx, "tx");

  const [txBlockHeight, height] = await Promise.all([
    pollBlockHeight(tx, chainId, deps),
    currentHeight(chainId, deps),
  ]);

  const depth =
    txBlockHeight === undefined ? 0 : Math.max(0, height - txBlockHeight);
  const status = depth >= input.finalityDepth ? "final" : "pending";

  const result: Confirmations = {
    chain: "stoachain",
    chainId,
    tx,
    status,
    depth,
    finalityDepth: input.finalityDepth,
  };
  if (txBlockHeight !== undefined) {
    result.blockHeight = txBlockHeight;
  }
  return result;
}
