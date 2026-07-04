/**
 * Client-side mirror of the Pythia service error taxonomy. The service taxonomy
 * is flat (each error extends `Error` directly across `dial/errors.ts` and
 * `reads/errors.ts`); the SDK adds a shared {@link PythiaClientError} root so a
 * consumer can `instanceof`-catch every Pythia-originated condition with one
 * check while still discriminating the specific subclasses. Each class sets
 * `name` to its own name for wire-stable identification, mirroring the service
 * convention.
 */

/** One attempted host's transport failure, as carried by the 502 body. */
export interface SourceFailure {
  sourceId: string;
  url: string;
  cause: unknown;
}

/** Shared root of every Pythia client error. Consumers catch this to handle any
 * Pythia-originated failure; the subclasses discriminate the specific cause. */
export class PythiaClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PythiaClientError";
  }
}

/** A missing or empty required input the service rejected (a 400 whose message
 * names the field, e.g. `"tx is required..."`). */
export class PythiaValidationError extends PythiaClientError {
  constructor(message: string) {
    super(message);
    this.name = "PythiaValidationError";
  }
}

/** A chain the service does not serve (a 400 whose message starts
 * `"Unsupported chain:"`). Not reachable through normal client use since the
 * client always sets `chain=stoachain`, but mapped for a changed service. */
export class PythiaUnsupportedChainError extends PythiaClientError {
  constructor(message: string) {
    super(message);
    this.name = "PythiaUnsupportedChainError";
  }
}

/** The whole node pool was exhausted (a 502 `{error:"PythiaPoolExhaustedError",
 * chainId?, failures}`). Carries each per-source failure and the optional chain
 * scope so a consumer can inspect what went down. */
export class PythiaPoolExhaustedError extends PythiaClientError {
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
