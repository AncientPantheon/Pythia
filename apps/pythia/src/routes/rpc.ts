import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  assertChainId,
  dial,
  PythiaPoolExhaustedError,
  PythiaValidationError,
  STOA_NETWORK,
  type FetchImpl,
} from "../dial/index.js";
import { loadConfigFromDisk, type SourceConfig } from "../config/index.js";
import { PYTHIA_POOL_EXHAUSTED, PYTHIA_VALIDATION } from "./errorEnvelope.js";

export interface RpcDeps {
  /** Primary + fallback sources. Injectable so tests avoid disk/network;
   * defaults to the config-resolved roles. */
  sources?: { primary: SourceConfig; fallback: SourceConfig };
  /** Injected fetch. Defaults to the global. */
  fetchImpl?: FetchImpl;
}

function resolveSources(deps: RpcDeps): {
  primary: SourceConfig;
  fallback: SourceConfig;
} {
  if (deps.sources) return deps.sources;
  const config = loadConfigFromDisk();
  const primary = config.sources.find((s) => s.role === "primary")!;
  const fallback = config.sources.find((s) => s.role === "fallback")!;
  return { primary, fallback };
}

/** Build the chainweb local read path for a host + chain. Kept inline so no
 * `@stoachain/stoa-core/network` import is needed. */
function localReadPath(host: string, chainId: number): string {
  return `${host}/chainweb/0.0/${STOA_NETWORK}/chain/${chainId}/pact/api/v1/local`;
}

/**
 * Register `POST /stoachain/rpc` — a verbatim relay. Validates chainId (0-9,
 * default 0) BEFORE any network attempt; forwards the caller's `payload`
 * byte-for-byte to the active host's chainweb local read path over the dial's
 * failover loop; returns the node response verbatim. Adds NO key material and
 * never reaches any broadcast/signing surface — read-only pass-through only.
 * Pool exhaustion → 502 with the per-source failures.
 */
/** Maximum relay body size. A signed Pact `/local` command is small (well under
 * a KB); 1 MB is a generous ceiling that still rejects a DoS-sized body before
 * it is buffered or forwarded. */
const MAX_RELAY_BODY_BYTES = 1024 * 1024;

export function registerRpc(app: Hono, deps: RpcDeps = {}): void {
  app.post(
    "/stoachain/rpc",
    bodyLimit({
      maxSize: MAX_RELAY_BODY_BYTES,
      onError: (c: Context) =>
        c.json({ error: "Request body too large" }, 413),
    }),
    async (c) => {
    const parsed = (await c.req.json().catch(() => null)) as {
      chainId?: unknown;
      payload?: unknown;
    } | null;

    if (parsed === null || typeof parsed !== "object") {
      return c.json(
        { code: PYTHIA_VALIDATION, error: "Request body must be a JSON object" },
        400,
      );
    }

    let chainId: number;
    try {
      chainId = assertChainId(parsed.chainId);
    } catch (err) {
      if (err instanceof PythiaValidationError) {
        return c.json({ code: PYTHIA_VALIDATION, error: err.message }, 400);
      }
      throw err;
    }

    // Verbatim forward: the caller's payload is re-serialized unchanged — no
    // reshaping, no added fields, no signature, no key material.
    const forwardedBody = JSON.stringify(parsed.payload);
    const { primary, fallback } = resolveSources(deps);

    try {
      const response = await dial(
        {
          chainId,
          buildRequest: (host) => [
            localReadPath(host, chainId),
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: forwardedBody,
            },
          ],
        },
        { primary, fallback, fetchImpl: deps.fetchImpl },
      );

      // Pass the node's response through verbatim (status + body).
      const text = await response.text();
      return new Response(text, {
        status: response.status,
        headers: {
          "content-type":
            response.headers.get("content-type") ?? "application/json",
        },
      });
    } catch (err) {
      if (err instanceof PythiaPoolExhaustedError) {
        return c.json(
          {
            code: PYTHIA_POOL_EXHAUSTED,
            error: "PythiaPoolExhaustedError",
            chainId: err.chainId,
            failures: err.failures.map((f) => ({
              sourceId: f.sourceId,
              url: f.url,
              cause: String(
                f.cause instanceof Error ? f.cause.message : f.cause,
              ),
            })),
          },
          502,
        );
      }
      throw err;
    }
  });
}

