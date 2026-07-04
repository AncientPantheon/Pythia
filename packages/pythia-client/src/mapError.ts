import {
  PythiaClientError,
  PythiaValidationError,
  PythiaUnsupportedChainError,
  PythiaPoolExhaustedError,
  type SourceFailure,
} from "./errors.js";

/** The shape of a Pythia service error envelope (400/502/503 bodies). Every
 * Pythia-origin envelope carries a `code` discriminator; a node-arrived relay
 * body does not. */
interface ServiceErrorBody {
  code?: unknown;
  error?: unknown;
  chainId?: unknown;
  failures?: unknown;
}

/** Stable discriminators the SERVICE stamps on its OWN error envelopes. These
 * mirror `apps/pythia/src/routes/errorEnvelope.ts` — the wire contract between
 * the two workspaces. */
const PYTHIA_VALIDATION = "pythia_validation";
const PYTHIA_UNSUPPORTED_CHAIN = "pythia_unsupported_chain";
const PYTHIA_UPSTREAM = "pythia_upstream";
const PYTHIA_POOL_EXHAUSTED = "pythia_pool_exhausted";

const PYTHIA_CODES = new Set<string>([
  PYTHIA_VALIDATION,
  PYTHIA_UNSUPPORTED_CHAIN,
  PYTHIA_UPSTREAM,
  PYTHIA_POOL_EXHAUSTED,
]);

/**
 * Decode a non-2xx PYTHIA service response into the matching client-side typed
 * error, discriminating on the envelope's self-identifying `code`:
 * `pythia_pool_exhausted` → {@link PythiaPoolExhaustedError} (with
 * `failures`/`chainId`); `pythia_unsupported_chain` →
 * {@link PythiaUnsupportedChainError}; `pythia_validation` →
 * {@link PythiaValidationError}; anything else (incl. `pythia_upstream` and an
 * absent code) → the base {@link PythiaClientError}. Only PYTHIA's own envelopes
 * reach here — node-arrived relay responses are returned verbatim by the client.
 */
export function mapServiceError(
  status: number,
  body: unknown,
): PythiaClientError {
  const envelope = (body ?? {}) as ServiceErrorBody;
  const message = typeof envelope.error === "string" ? envelope.error : "";
  const code = typeof envelope.code === "string" ? envelope.code : "";

  if (code === PYTHIA_POOL_EXHAUSTED) {
    return new PythiaPoolExhaustedError({
      failures: Array.isArray(envelope.failures)
        ? (envelope.failures as SourceFailure[])
        : [],
      ...(typeof envelope.chainId === "number"
        ? { chainId: envelope.chainId }
        : {}),
    });
  }

  if (code === PYTHIA_UNSUPPORTED_CHAIN) {
    return new PythiaUnsupportedChainError(message);
  }

  if (code === PYTHIA_VALIDATION) {
    return new PythiaValidationError(message);
  }

  return new PythiaClientError(
    message || `Pythia service error (HTTP ${status})`,
  );
}

/** Whether a service response body is one of Pythia's OWN error envelopes (as
 * opposed to a node-arrived relay body). Keys off the self-identifying `code`
 * discriminator: only Pythia's own bodies carry a known `code`. Used by `rpc`
 * to decide whether a non-2xx response is mapped to a typed error or returned
 * verbatim — a node's own `{error:"…"}` 400 has no `code` and is passed through. */
export function isPythiaErrorEnvelope(_status: number, body: unknown): boolean {
  const envelope = (body ?? {}) as ServiceErrorBody;
  return typeof envelope.code === "string" && PYTHIA_CODES.has(envelope.code);
}
