/**
 * Response and input types for the Pythia client. These are re-declared locally
 * (NOT imported from the private `apps/pythia` service package) so the SDK stays
 * dependency-light. The shapes are copied verbatim from the service's read
 * decoders and the `/healthz` route so a consumer gets the exact wire contract.
 * All monetary amounts are decimal STRINGS, never `number`.
 */

/** The composite balance returned by `GET /api/v1/getBalance`. A `"0"` amount
 * is a legitimate no-balance answer, not an error. */
export interface Balance {
  chain: "stoachain";
  address: string;
  ignis: string;
  ouroDispo: string;
  virtualOuro: string;
  token?: { id: string; supply: string };
}

/** The decoded confirmation status returned by `GET /api/v1/getConfirmations`. */
export interface Confirmations {
  chain: "stoachain";
  chainId: number;
  tx: string;
  status: "pending" | "final";
  depth: number;
  finalityDepth: number;
  /** Present once the tx is mined into a block. */
  blockHeight?: number;
}

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

/** Input to `client.getBalance`. The client sets `chain=stoachain` itself. */
export interface GetBalanceInput {
  address: string;
  /** Optional arbitrary DPTF token id to also resolve. */
  token?: string;
}

/** Input to `client.getConfirmations`. The client sets `chain=stoachain` itself. */
export interface GetConfirmationsInput {
  tx: string;
  /** Chainweb chain the tx lives on (0-9, default 0 at the service). */
  chainId?: number;
}

/** Input to `client.rpc`. `payload` is forwarded to the node verbatim. */
export interface RpcInput {
  chainId?: number;
  payload: unknown;
}
