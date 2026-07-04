import { PythiaValidationError } from "./errors.js";

/** Stoa exposes exactly chains 0-9 (STOA_CHAIN_COUNT=10). */
const MIN_CHAIN = 0;
const MAX_CHAIN = 9;

/**
 * Validate a caller-supplied chain id as an integer in [0,9]. Absent input
 * (`undefined`/`null`) defaults to chain 0. A numeric string is coerced to its
 * integer value. Any out-of-range, non-integer, or non-numeric input throws a
 * {@link PythiaValidationError} — the caller must reject BEFORE any network read.
 */
export function assertChainId(input: unknown): number {
  if (input === undefined || input === null) {
    return 0;
  }

  let value: number;
  if (typeof input === "number") {
    value = input;
  } else if (typeof input === "string" && input.trim() !== "") {
    value = Number(input);
  } else {
    throw new PythiaValidationError(
      `chainId must be an integer 0-9 (got ${JSON.stringify(input)})`,
    );
  }

  if (!Number.isInteger(value) || value < MIN_CHAIN || value > MAX_CHAIN) {
    throw new PythiaValidationError(
      `chainId must be an integer 0-9 (got ${JSON.stringify(input)})`,
    );
  }

  return value;
}
