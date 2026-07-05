import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  assertChainId,
  dial,
  PythiaValidationError,
  STOA_NETWORK,
} from "../dial/index.js";
import { buildLocalCommand } from "../chainweb/localCommand.js";
import { loadConfigFromDisk } from "../config/index.js";
import {
  MAX_RELAY_BODY_BYTES,
  passthrough,
  resolveSources,
  respondRelayError,
  type RelayDeps,
} from "./relay.js";

export interface ReadDeps extends RelayDeps {
  /** Default gas ceiling applied when the request body omits `gasLimit`.
   * Injectable so tests avoid disk; defaults to the config-resolved value. */
  readGasLimit?: number;
}

/** Build the chainweb /local read path for a host + chain. */
function localReadPath(host: string, chainId: number): string {
  return `${host}/chainweb/0.0/${STOA_NETWORK}/chain/${chainId}/pact/api/v1/local`;
}

/**
 * Register `POST /stoachain/read` — a generic dirty read. Body:
 * `{ chainId?=0, code, data?, sender? }`. Validates a non-empty `code`
 * (→ 400 pythia_validation) and the chainId (0-9, default 0 → 400) BEFORE any
 * network attempt, then builds the node-required `/local` command envelope
 * (`{cmd,hash,sigs}` with `hash == blake2b(cmd)`, empty sigs) and relays it over
 * the dial's failover loop. The node's response is returned VERBATIM — a read
 * that needs keys/caps comes back as the node's own `{result:{status:"failure"}}`
 * and that failure IS the useful output, passed through undecoded. Keyless —
 * Pythia adds no key material and signs nothing. Pool exhaustion → 502.
 */
export function registerRead(app: Hono, deps: ReadDeps = {}): void {
  app.post(
    "/stoachain/read",
    bodyLimit({
      maxSize: MAX_RELAY_BODY_BYTES,
      onError: (c: Context) => c.json({ error: "Request body too large" }, 413),
    }),
    async (c) => {
      const parsed = (await c.req.json().catch(() => null)) as {
        chainId?: unknown;
        code?: unknown;
        data?: object;
        sender?: string;
        gasLimit?: unknown;
      } | null;

      if (parsed === null || typeof parsed !== "object") {
        return c.json(
          { code: "pythia_validation", error: "Request body must be a JSON object" },
          400,
        );
      }

      let chainId: number;
      let code: string;
      let gasLimit: number;
      try {
        chainId = assertChainId(parsed.chainId);
        if (typeof parsed.code !== "string" || parsed.code.trim() === "") {
          throw new PythiaValidationError(
            "code is required and must be a non-empty string",
          );
        }
        code = parsed.code;
        // Effective budget: an explicit body override (validated) wins, else the
        // injected/config default. The node accepts any ceiling for empty-sender
        // reads, so the default is generous rather than the old 150k budget.
        if (parsed.gasLimit !== undefined) {
          if (
            typeof parsed.gasLimit !== "number" ||
            !Number.isInteger(parsed.gasLimit) ||
            parsed.gasLimit < 1
          ) {
            throw new PythiaValidationError(
              "gasLimit must be a positive integer when present",
            );
          }
          gasLimit = parsed.gasLimit;
        } else {
          gasLimit = deps.readGasLimit ?? loadConfigFromDisk().readGasLimit;
        }
      } catch (err) {
        return respondRelayError(c, err);
      }

      const body = buildLocalCommand(code, {
        chainId,
        gasLimit,
        ...(parsed.data !== undefined ? { data: parsed.data } : {}),
        ...(parsed.sender !== undefined ? { sender: parsed.sender } : {}),
      });
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
                body,
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
