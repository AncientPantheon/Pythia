import type { Hono } from "hono";
import { assertChainId, type FetchImpl } from "../dial/index.js";
import { assertStoachain, readConfirmations } from "../reads/index.js";
import {
  DEFAULT_FINALITY_DEPTH,
  loadConfigFromDisk,
  type SourceConfig,
} from "../config/index.js";
import { resolveSources, respondReadError } from "./getBalance.js";

export interface ConfirmationsRouteDeps {
  sources?: { primary: SourceConfig; fallback: SourceConfig };
  fetchImpl?: FetchImpl;
  /** Confirmation depth for finality. Injectable; defaults to the config value. */
  finalityDepth?: number;
}

function resolveFinalityDepth(deps: ConfirmationsRouteDeps): number {
  if (deps.finalityDepth !== undefined) return deps.finalityDepth;
  if (deps.sources) return DEFAULT_FINALITY_DEPTH;
  return loadConfigFromDisk().finalityDepth;
}

/**
 * Register `GET /api/v1/getConfirmations?chain=stoachain&tx=…&chainId=<0-9>?`.
 * Validates the chain name (only `stoachain` → 400 otherwise), a non-empty tx
 * (→ 400), and the chainId (0-9, default 0 → 400 on out-of-range) BEFORE any
 * node read. Resolves `finalityDepth` from config (default 6) and returns the
 * decoded pending-vs-final status/depth. Pool exhaustion → 502.
 */
export function registerGetConfirmations(
  app: Hono,
  deps: ConfirmationsRouteDeps = {},
): void {
  app.get("/api/v1/getConfirmations", async (c) => {
    const chainIdParam = c.req.query("chainId");
    let chainId: number;
    let tx: string;
    try {
      assertStoachain(c.req.query("chain"));
      chainId = assertChainId(chainIdParam);
      tx = c.req.query("tx") ?? "";
    } catch (err) {
      return respondReadError(c, err);
    }

    const { primary, fallback } = resolveSources(deps);
    try {
      const confirmations = await readConfirmations(
        { tx, chainId, finalityDepth: resolveFinalityDepth(deps) },
        { primary, fallback, fetchImpl: deps.fetchImpl },
      );
      return c.json(confirmations, 200);
    } catch (err) {
      return respondReadError(c, err);
    }
  });
}
