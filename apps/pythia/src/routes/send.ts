import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  assertChainId,
  dialNodes,
  PythiaValidationError,
  STOA_NETWORK,
  type DialNode,
  type FetchImpl,
} from "../dial/index.js";
import type { TxSenderStore } from "../txsenders/store.js";
import {
  MAX_RELAY_BODY_BYTES,
  passthrough,
  respondRelayError,
} from "./relay.js";

export interface SendDeps {
  /** Injected fetch. Defaults to the global. */
  fetchImpl?: FetchImpl;
  /** Explicit Upload-Pool nodes (injected for tests). */
  senders?: DialNode[];
  /** The Upload-Pool store; its ENABLED senders are tried in order. */
  store?: TxSenderStore;
}

/** Build the chainweb /send path for a host + chain. */
function sendPath(host: string, chainId: number): string {
  return `${host}/chainweb/0.0/${STOA_NETWORK}/chain/${chainId}/pact/api/v1/send`;
}

/** The ordered Upload-Pool senders for this request. */
function resolveSenders(deps: SendDeps): DialNode[] {
  if (deps.senders) return deps.senders;
  if (deps.store) return deps.store.enabledNodes();
  return [];
}

/**
 * Register `POST /stoachain/send` — a keyless broadcast relay routed EXCLUSIVELY
 * to the **Upload Pool** (the ancient-managed dedicated tx-sender nodes), tried
 * "one after the other". Body: `{ chainId?=0, cmds }` (caller-SIGNED). It relays
 * `{ cmds }` VERBATIM and returns the node response verbatim. Keyless — Pythia
 * adds nothing and signs nothing.
 *
 * Sends NEVER touch the hub-fed read (Observation) pool and are NEVER metered as
 * usage — Upload-Pool nodes earn no PythXP. An EMPTY/all-disabled Upload Pool
 * returns **503** rather than falling back to read/seed nodes: predictable tx
 * delivery is the whole point. Pool exhaustion → 502.
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

      const senders = resolveSenders(deps);
      if (senders.length === 0) {
        // Fail closed — a signed tx is NEVER routed to a read/seed node.
        return c.json(
          {
            code: "pythia_no_tx_sender",
            error:
              "no tx-sender configured — add an Upload-Pool node in the admin Hub-feed panel",
          },
          503,
        );
      }

      // Keyless verbatim forward: relay exactly `{ cmds }` — no reshaping, no
      // added fields, no signature, no key material.
      const forwardedBody = JSON.stringify({ cmds });

      try {
        const response = await dialNodes(
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
          { nodes: senders, fetchImpl: deps.fetchImpl },
        );
        return passthrough(response);
      } catch (err) {
        return respondRelayError(c, err);
      }
    },
  );
}
