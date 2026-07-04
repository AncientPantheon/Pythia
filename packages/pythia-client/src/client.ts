import { Transport, type ParsedResponse } from "./transport.js";
import { mapServiceError, isPythiaErrorEnvelope } from "./mapError.js";
import type {
  Balance,
  Confirmations,
  HealthSnapshot,
  PythiaClientOptions,
  GetBalanceInput,
  GetConfirmationsInput,
  RpcInput,
} from "./types.js";

/** The chain every v1 request targets. The client sets this itself so a
 * consumer never passes `chain`. */
const CHAIN = "stoachain";

/**
 * The dependency-light Pythia consumer SDK. Wraps the four gateway endpoints
 * over a configurable `baseUrl` with an injectable `fetchImpl`, always setting
 * `chain=stoachain` itself, and surfaces the service error taxonomy as
 * client-side typed errors. The only reads exposed are the gateway's own
 * read-only surface — no broadcast/signing.
 */
export class PythiaClient {
  private readonly transport: Transport;

  constructor(options: PythiaClientOptions) {
    this.transport = new Transport(options);
  }

  /** Throw the mapped typed error for any non-2xx service response. */
  private assertOk(response: ParsedResponse): void {
    if (response.status < 200 || response.status >= 300) {
      throw mapServiceError(response.status, response.body);
    }
  }

  /** `GET /api/v1/getBalance` — composite StoaChain balance. A `"0"` amount at
   * 200 is a real no-balance answer, not an error. */
  async getBalance(input: GetBalanceInput): Promise<Balance> {
    const query: Record<string, string> = {
      chain: CHAIN,
      address: input.address,
    };
    if (input.token !== undefined) {
      query.token = input.token;
    }
    const response = await this.transport.get("/api/v1/getBalance", query);
    this.assertOk(response);
    return response.body as Balance;
  }

  /** `GET /api/v1/getConfirmations` — decoded pending-vs-final status/depth. */
  async getConfirmations(
    input: GetConfirmationsInput,
  ): Promise<Confirmations> {
    const query: Record<string, string> = { chain: CHAIN, tx: input.tx };
    if (input.chainId !== undefined) {
      query.chainId = String(input.chainId);
    }
    const response = await this.transport.get(
      "/api/v1/getConfirmations",
      query,
    );
    this.assertOk(response);
    return response.body as Confirmations;
  }

  /**
   * `POST /stoachain/rpc` — verbatim node relay. Returns the node's parsed body
   * as-is on 2xx. Only Pythia's OWN error envelopes (its bad-body/chainId 400
   * and pool-exhausted 502) are mapped to typed errors; a node-arrived HTTP
   * error is returned verbatim as the node's own payload, never remapped.
   */
  async rpc(input: RpcInput): Promise<unknown> {
    const body: { chainId?: number; payload: unknown } = {
      payload: input.payload,
    };
    if (input.chainId !== undefined) {
      body.chainId = input.chainId;
    }
    const response = await this.transport.postJson("/stoachain/rpc", body);

    if (
      (response.status < 200 || response.status >= 300) &&
      isPythiaErrorEnvelope(response.status, response.body)
    ) {
      throw mapServiceError(response.status, response.body);
    }
    // 2xx node body, or a node-arrived HTTP error body — returned verbatim.
    return response.body;
  }

  /** `GET /healthz` — liveness + active routing + per-source reachability
   * (always HTTP 200). */
  async health(): Promise<HealthSnapshot> {
    const response = await this.transport.get("/healthz");
    this.assertOk(response);
    return response.body as HealthSnapshot;
  }
}
