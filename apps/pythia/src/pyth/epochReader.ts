import { dial, STOA_NETWORK } from "../dial/index.js";
import type { FetchImpl } from "../dial/index.js";
import { buildLocalCommand } from "../chainweb/localCommand.js";
import { resolveReadPair } from "../routes/relay.js";
import type { NodePool } from "../pool/nodePool.js";
import { parseEpochResult } from "./epoch.js";

/**
 * Keyless read of the on-chain ledger epoch (`PYTHIA.UR_PythLedgerEpochStart`) — a plain
 * `/local` dirty read over the same failover dial the client read path uses. Returns the
 * epoch as UTC ms, or null on any failure (no read node, node error, unparseable result)
 * so the caller keeps the hardcoded default. Reads only; signs nothing.
 */
const EPOCH_CODE = "(ouronet-ns.PYTHIA.UR_PythLedgerEpochStart)";

/** The chain the PYTHIA ledger module lives on (env override, default 0). */
function ledgerChainId(): number {
  const raw = Number(process.env.PYTH_LEDGER_CHAIN);
  return Number.isInteger(raw) && raw >= 0 && raw <= 19 ? raw : 0;
}

export function createEpochReader(pool: NodePool, fetchImpl?: FetchImpl): () => Promise<number | null> {
  return async () => {
    const pair = resolveReadPair({ pool });
    if (!pair) return null; // no read node available
    const chainId = ledgerChainId();
    try {
      const res = await dial(
        {
          chainId,
          buildRequest: (host) => [
            `${host}/chainweb/0.0/${STOA_NETWORK}/chain/${chainId}/pact/api/v1/local`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: buildLocalCommand(EPOCH_CODE, { chainId }),
            },
          ],
        },
        { primary: pair.primary, fallback: pair.fallback, fetchImpl },
      );
      const body = (await res.json().catch(() => null)) as
        | { result?: { status?: string; data?: unknown } }
        | null;
      if (!body?.result || body.result.status !== "success") return null;
      return parseEpochResult(body.result.data);
    } catch {
      return null;
    }
  };
}
