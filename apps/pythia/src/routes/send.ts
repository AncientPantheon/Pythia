import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  assertChainId,
  dial,
  PythiaValidationError,
  STOA_NETWORK,
} from "../dial/index.js";
import {
  MAX_RELAY_BODY_BYTES,
  passthrough,
  resolveSources,
  respondRelayError,
  type RelayDeps,
} from "./relay.js";

export type SendDeps = RelayDeps;

/** Build the chainweb /send path for a host + chain. */
function sendPath(host: string, chainId: number): string {
  return `${host}/chainweb/0.0/${STOA_NETWORK}/chain/${chainId}/pact/api/v1/send`;
}

/**
 * Register `POST /stoachain/send` — a keyless broadcast relay. Body:
 * `{ chainId?=0, cmds }` where `cmds` is the chainweb `/send` array of
 * caller-SIGNED commands. Validates the chainId (0-9, default 0 → 400) and a
 * non-empty `cmds` array (→ 400 pythia_validation) BEFORE any network attempt,
 * then relays `{ cmds }` VERBATIM to the node's `/send` path over the dial's
 * failover loop and returns the node response verbatim. Keyless — Pythia adds
 * nothing and signs nothing; this is a plain fetch to the node's /send endpoint,
 * not any signing/broadcast client. Pool exhaustion → 502.
 */
export function registerSend(app: Hono, deps: SendDeps = {}): void {
  app.post(
    "/stoachain/send",
    bodyLimit({
      maxSize: MAX_RELAY_BODY_BYTES,
      onError: (c: Context) => c.json({ error: "Request body too large" }, 413),
    }),
    async (c) => {
      const parsed = (await c.req.json().catch(() => null)) as {
        chainId?: unknown;
        cmds?: unknown;
      } | null;

      if (parsed === null || typeof parsed !== "object") {
        return c.json(
          { code: "pythia_validation", error: "Request body must be a JSON object" },
          400,
        );
      }

      let chainId: number;
      let cmds: unknown[];
      try {
        chainId = assertChainId(parsed.chainId);
        if (!Array.isArray(parsed.cmds) || parsed.cmds.length === 0) {
          throw new PythiaValidationError(
            "cmds is required and must be a non-empty array",
          );
        }
        cmds = parsed.cmds;
      } catch (err) {
        return respondRelayError(c, err);
      }

      // Keyless verbatim forward: relay exactly `{ cmds }` — no reshaping, no
      // added fields, no signature, no key material.
      const forwardedBody = JSON.stringify({ cmds });
      const { primary, fallback } = resolveSources(deps);

      try {
        const response = await dial(
          {
            chainId,
            buildRequest: (host) => [
              sendPath(host, chainId),
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: forwardedBody,
              },
            ],
          },
          { primary, fallback, fetchImpl: deps.fetchImpl },
        );
        return passthrough(response);
      } catch (err) {
        return respondRelayError(c, err);
      }
    },
  );
}
