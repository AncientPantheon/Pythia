import type { Context } from "hono";
import {
  PythiaPoolExhaustedError,
  PythiaValidationError,
  type FetchImpl,
} from "../dial/index.js";
import { PythiaUpstreamError } from "../reads/index.js";
import { loadConfigFromDisk, type SourceConfig } from "../config/index.js";
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
