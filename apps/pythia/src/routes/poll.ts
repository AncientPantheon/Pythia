import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { PythiaValidationError, type FetchImpl } from "../dial/index.js";
import { pollConfirmations } from "../reads/index.js";
import type { NodePool } from "../pool/nodePool.js";
import {
  DEFAULT_FINALITY_DEPTH,
  loadConfigFromDisk,
  type SourceConfig,
} from "../config/index.js";
import {
  MAX_RELAY_BODY_BYTES,
  resolveReadPair,
  respondRelayError,
} from "./relay.js";

export interface PollRouteDeps {
  sources?: { primary: SourceConfig; fallback: SourceConfig };
  fetchImpl?: FetchImpl;
  /** Confirmation depth for finality. Injectable; defaults to the config value. */
  finalityDepth?: number;
  /** The live read-node pool; poll (a read) draws a rotating pair from it. */
  pool?: NodePool;
}

function resolveFinalityDepth(deps: PollRouteDeps): number {
  if (deps.finalityDepth !== undefined) return deps.finalityDepth;
  if (deps.sources) return DEFAULT_FINALITY_DEPTH;
  return loadConfigFromDisk().finalityDepth;
}

/**
 * Register `POST /stoachain/poll` — tx-status polling. Body:
 * `{ chainId?=0, requestKeys }`. Validates the chainId (0-9, default 0 → 400)
 * and a non-empty `requestKeys` array (→ 400 pythia_validation) BEFORE any
 * network attempt, then resolves each key's confirmation status over the poll +
 * cut reads and returns
 * `{ chainId, finalityDepth, results: { <requestKey>: {status,depth,blockHeight?} } }`.
 * A poll upstream 4xx → 400; pool exhaustion → 502.
 */
export function registerPoll(app: Hono, deps: PollRouteDeps = {}): void {
  app.post(
    "/stoachain/poll",
    bodyLimit({
      maxSize: MAX_RELAY_BODY_BYTES,
      onError: (c: Context) => c.json({ error: "Request body too large" }, 413),
    }),
    async (c) => {
      const parsed = (await c.req.json().catch(() => null)) as {
        chainId?: unknown;
        requestKeys?: unknown;
      } | null;

      if (parsed === null || typeof parsed !== "object") {
        return c.json(
          { code: "pythia_validation", error: "Request body must be a JSON object" },
          400,
        );
      }

      let requestKeys: string[];
      try {
        if (
          !Array.isArray(parsed.requestKeys) ||
          parsed.requestKeys.length === 0
        ) {
          throw new PythiaValidationError(
            "requestKeys is required and must be a non-empty array",
          );
        }
        requestKeys = parsed.requestKeys as string[];
      } catch (err) {
        return respondRelayError(c, err);
      }

      const pair = resolveReadPair(deps);
      if (!pair) {
        return c.json(
          {
            code: "pythia_no_read_node",
            error:
              "no read node available — the hub feed is off/down and the Upload Pool is empty",
          },
          503,
        );
      }
      const { primary, fallback } = pair;
      try {
        const results = await pollConfirmations(
          {
            requestKeys,
            chainId: parsed.chainId as number | undefined,
            finalityDepth: resolveFinalityDepth(deps),
          },
          { primary, fallback, fetchImpl: deps.fetchImpl },
        );
        return c.json(results, 200);
      } catch (err) {
        return respondRelayError(c, err);
      }
    },
  );
}
