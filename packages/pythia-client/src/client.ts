import { Transport, type ParsedResponse } from "./transport.js";
import { mapServiceError, isPythiaErrorEnvelope } from "./mapError.js";
import type {
  HealthSnapshot,
  PythiaClientOptions,
  ReadInput,
  SendInput,
  PollInput,
  PollResult,
} from "./types.js";

/**
 * The dependency-light Pythia consumer SDK. Wraps the keyless gateway's
 * transport surface over a configurable `baseUrl` with an injectable
 * `fetchImpl`: a generic dirty `read`, a keyless `send` (relay of caller-SIGNED
 * cmds), a tx-status `poll`, and `health`. The client holds no keys and signs
 * nothing — `read` and `send` relay caller-supplied payloads and return the
 * node response verbatim; only Pythia's OWN error envelopes are mapped to typed
 * errors.
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

  /**
   * Return the parsed body for a relay response. On 2xx the node body is
   * returned as-is. On a non-2xx that is one of Pythia's OWN error envelopes
   * (self-identifying via `code`), the mapped typed error is thrown; a
   * node-arrived HTTP error (no `code`) is returned verbatim as the node's own
   * payload, never remapped — preserving the verbatim-relay contract.
   */
  private relayResult(response: ParsedResponse): unknown {
    if (
      (response.status < 200 || response.status >= 300) &&
      isPythiaErrorEnvelope(response.status, response.body)
    ) {
      throw mapServiceError(response.status, response.body);
    }
    return response.body;
  }

  /**
   * `POST /stoachain/read` — a generic dirty read. The caller supplies the Pact
   * `code` (plus optional `data`/`sender`/`chainId`); the node evaluates it and
   * the response is returned verbatim. A read that needs keys/caps comes back as
   * the node's own `{result:{status:"failure"}}` — that is a real answer, not an
   * error, and is returned as-is.
   */
  async read(input: ReadInput): Promise<unknown> {
    const body: {
      chainId?: number;
      code: string;
      data?: object;
      sender?: string;
    } = { code: input.code };
    if (input.chainId !== undefined) body.chainId = input.chainId;
    if (input.data !== undefined) body.data = input.data;
    if (input.sender !== undefined) body.sender = input.sender;

    const response = await this.transport.postJson("/stoachain/read", body);
    return this.relayResult(response);
  }

  /**
   * `POST /stoachain/send` — a keyless broadcast. Relays the caller-SIGNED
   * `cmds` array to the node's /send verbatim and returns the node response
   * as-is. The client adds no key material and signs nothing.
   */
  async send(input: SendInput): Promise<unknown> {
    const body: { chainId?: number; cmds: unknown[] } = { cmds: input.cmds };
    if (input.chainId !== undefined) body.chainId = input.chainId;

    const response = await this.transport.postJson("/stoachain/send", body);
    return this.relayResult(response);
  }

  /**
   * `POST /stoachain/poll` — tx-status polling. Resolves each request key's
   * pending-vs-final status and confirmation depth, returned as a typed
   * {@link PollResult} keyed by request key.
   */
  async poll(input: PollInput): Promise<PollResult> {
    const body: { chainId?: number; requestKeys: string[] } = {
      requestKeys: input.requestKeys,
    };
    if (input.chainId !== undefined) body.chainId = input.chainId;

    const response = await this.transport.postJson("/stoachain/poll", body);
    this.assertOk(response);
    return response.body as PollResult;
  }

  /** `GET /healthz` — liveness + active routing + per-source reachability
   * (always HTTP 200). */
  async health(): Promise<HealthSnapshot> {
    const response = await this.transport.get("/healthz");
    this.assertOk(response);
    return response.body as HealthSnapshot;
  }
}
