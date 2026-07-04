import type { Context, Hono } from "hono";
import {
  PythiaPoolExhaustedError,
  PythiaValidationError,
  type FetchImpl,
} from "../dial/index.js";
import {
  assertStoachain,
  readBalance,
  PythiaUnsupportedChainError,
  PythiaUpstreamError,
} from "../reads/index.js";
import { loadConfigFromDisk, type SourceConfig } from "../config/index.js";
import {
  PYTHIA_POOL_EXHAUSTED,
  PYTHIA_UNSUPPORTED_CHAIN,
  PYTHIA_UPSTREAM,
  PYTHIA_VALIDATION,
} from "./errorEnvelope.js";

export interface ReadRouteDeps {
  /** Primary + fallback sources. Injectable so tests avoid disk/network;
   * defaults to the config-resolved roles. */
  sources?: { primary: SourceConfig; fallback: SourceConfig };
  /** Injected fetch. Defaults to the global. */
  fetchImpl?: FetchImpl;
}

export function resolveSources(deps: ReadRouteDeps): {
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
 * Map a thrown read error to its HTTP response. Typed input errors → 400; a
 * fully-exhausted pool → 502 carrying the per-source failures (mirrors the
 * relay's mapping); an arrived-but-undecodable node response → a client 400 when
 * the node rejected the caller's input (upstream 4xx) or a 502 "upstream error"
 * for an upstream 5xx / non-JSON body. Anything else is re-thrown to the
 * framework — but no decode path reaches a raw 500 with a SyntaxError.
 */
export function respondReadError(c: Context, err: unknown): Response {
  if (err instanceof PythiaUnsupportedChainError) {
    return c.json({ code: PYTHIA_UNSUPPORTED_CHAIN, error: err.message }, 400);
  }
  if (err instanceof PythiaValidationError) {
    return c.json({ code: PYTHIA_VALIDATION, error: err.message }, 400);
  }
  if (err instanceof PythiaUpstreamError) {
    if (err.status >= 400 && err.status < 500) {
      // The node rejected the caller's own input (e.g. a malformed tx/address):
      // that is a client error, surfaced as a 400 with the node's reason.
      return c.json(
        {
          code: PYTHIA_UPSTREAM,
          error: `upstream rejected request: ${err.message}`,
        },
        400,
      );
    }
    // An upstream 5xx or a non-JSON/parse failure is a gateway-side fault.
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

/**
 * Register `GET /api/v1/getBalance?chain=stoachain&address=…&token=<id>?`. The
 * chain name is validated (only `stoachain` served → 400 on any other) and the
 * address is required-non-empty (→ 400) BEFORE any node read. On success returns
 * the composite decoded balance (IGNIS / OURO dispo / virtual OURO, plus the
 * optional token supply). Pool exhaustion → 502 with the per-source failures.
 */
export function registerGetBalance(app: Hono, deps: ReadRouteDeps = {}): void {
  app.get("/api/v1/getBalance", async (c) => {
    let address: string;
    // `?token=` (empty) or a whitespace-only token is treated as ABSENT — it must
    // not trigger a spurious 4th supply read nor a bogus `token:{id:""}` field.
    const rawToken = c.req.query("token");
    const token =
      rawToken !== undefined && rawToken.trim() !== "" ? rawToken : undefined;
    try {
      assertStoachain(c.req.query("chain"));
      address = c.req.query("address") ?? "";
    } catch (err) {
      return respondReadError(c, err);
    }

    const { primary, fallback } = resolveSources(deps);
    try {
      const balance = await readBalance(
        {
          address,
          ...(token !== undefined ? { token } : {}),
        },
        { primary, fallback, fetchImpl: deps.fetchImpl },
      );
      return c.json(balance, 200);
    } catch (err) {
      return respondReadError(c, err);
    }
  });
}
