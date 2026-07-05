/**
 * Response and input types for the Pythia client. These are re-declared locally
 * (NOT imported from the private `apps/pythia` service package) so the SDK stays
 * dependency-light. The shapes mirror the keyless gateway's transport surface so
 * a consumer gets the exact wire contract. Node responses (read/send) pass
 * through verbatim as `unknown`; only the poll result has a typed shape.
 */

/** The active-routing tri-state the `/healthz` snapshot reports. */
export type Routing = "primary" | "fallback" | "unreachable";

/** One source's individual reachability, as reported by `/healthz`. */
export interface SourceHealth {
  id: string;
  url: string;
  role: "primary" | "fallback";
  reachable: boolean;
}

/** The service liveness snapshot returned by `GET /healthz` (always HTTP 200). */
export interface HealthSnapshot {
  service: "ok";
  active: { sourceId: string; url: string };
  routing: Routing;
  sources: SourceHealth[];
}

/** Constructor options for {@link PythiaClient}. `fetchImpl` defaults to the
 * runtime global `fetch`; inject it for tests or a custom transport. */
export interface PythiaClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

/** Input to `client.read` — a generic dirty read. The caller supplies the Pact
 * `code`; the node evaluates it and Pythia returns the response verbatim. */
export interface ReadInput {
  /** Chainweb chain the read targets (0-9, default 0 at the service). */
  chainId?: number;
  /** The Pact expression to evaluate on the node. */
  code: string;
  /** Optional Pact `data` map made available to the read code. */
  data?: object;
  /** Optional sender account recorded in the command meta. */
  sender?: string;
}

/** Input to `client.send` — a keyless broadcast. `cmds` is the chainweb `/send`
 * array of caller-SIGNED commands, relayed to the node verbatim. */
export interface SendInput {
  /** Chainweb chain the txs target (0-9, default 0 at the service). */
  chainId?: number;
  /** The chainweb `/send` `cmds` array of caller-signed commands. */
  cmds: unknown[];
}

/** Input to `client.poll` — tx-status polling by request key. */
export interface PollInput {
  /** Chainweb chain the txs live on (0-9, default 0 at the service). */
  chainId?: number;
  /** The request keys to resolve. Must be non-empty. */
  requestKeys: string[];
}

/** Per-request-key confirmation status. `blockHeight` is present once mined. */
export interface PollKeyResult {
  status: "pending" | "final";
  depth: number;
  blockHeight?: number;
}

/** The typed result returned by `POST /stoachain/poll`. */
export interface PollResult {
  chainId: number;
  finalityDepth: number;
  results: Record<string, PollKeyResult>;
}
