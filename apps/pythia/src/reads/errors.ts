/**
 * Raised when a caller names a chain the read layer does not serve. Pythia's
 * normalized reads speak exactly one chain (`stoachain`); any other name —
 * including an absent or empty one — is an unsupported-chain condition, DISTINCT
 * from a missing required input (which is a {@link PythiaValidationError}). Typed
 * so the route layer can map it to a 400. Mirrors the Phase-1/2 typed-error
 * convention (`name` set for wire-stable identification).
 */
export class PythiaUnsupportedChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PythiaUnsupportedChainError";
  }
}

/**
 * Raised when a node response ARRIVED but could not be decoded into the expected
 * JSON — either a non-ok HTTP status (the node rejected the request, e.g. a
 * malformed tx → 400 + plain text) or an ok status whose body was not valid JSON
 * (a proxy/gateway page). DISTINCT from {@link PythiaPoolExhaustedError}, which
 * is a transport failure of BOTH hosts thrown by `dial()` before any response
 * arrives. Carries the upstream HTTP `status`, a short body snippet as its
 * `message`, and the `source` URL that produced it so the route layer can map a
 * 4xx to a client 400 and a 5xx / parse failure to a 502. Mirrors the typed-error
 * convention (`name` set for wire-stable identification).
 */
export class PythiaUpstreamError extends Error {
  readonly status: number;
  readonly source: string;

  constructor(args: { status: number; message: string; source: string }) {
    super(args.message);
    this.name = "PythiaUpstreamError";
    this.status = args.status;
    this.source = args.source;
  }
}
