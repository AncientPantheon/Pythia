/**
 * One attempted host's transport failure, captured for the terminal error body.
 * `cause` is the raw rejection (network error / AbortError / ECONNREFUSED) so
 * the HTTP layer can surface it structurally without losing information.
 */
export interface SourceFailure {
  sourceId: string;
  url: string;
  cause: unknown;
}

/**
 * The single terminal error thrown when the whole node pool is exhausted —
 * every host attempted by the dial failed transport. Carries each per-source
 * failure in attempt order (primary then fallback) so the route layer can map
 * it to a 502/503 with a structured body. Shared by the relay (Phase 2) and the
 * normalized reads (Phase 3). Distinct from a node-returned HTTP error, which
 * the dial passes through rather than raising.
 */
export class PythiaPoolExhaustedError extends Error {
  readonly failures: SourceFailure[];
  readonly chainId?: number;

  constructor(args: { failures: SourceFailure[]; chainId?: number }) {
    super(
      `Node pool exhausted: ${args.failures.length} source(s) failed transport`,
    );
    this.name = "PythiaPoolExhaustedError";
    this.failures = args.failures;
    if (args.chainId !== undefined) {
      this.chainId = args.chainId;
    }
  }
}

/** Raised on invalid caller input (e.g. an out-of-range chain id) before any
 * network attempt. Typed so the route layer can map it to a 400. Mirrors the
 * Phase-1 {@link PythiaConfigError} convention. */
export class PythiaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PythiaValidationError";
  }
}
