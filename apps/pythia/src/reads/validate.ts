import { PythiaValidationError } from "../dial/index.js";
import { PythiaUnsupportedChainError } from "./errors.js";

/** The single chain the normalized reads serve. */
const SUPPORTED_CHAIN = "stoachain";

/**
 * Narrow a caller-supplied chain name to the one supported chain. Accepts only
 * the literal string `"stoachain"` (surrounding whitespace trimmed). ANY other
 * value — absent, empty, or a different chain name — throws
 * {@link PythiaUnsupportedChainError} BEFORE any network read, so an unknown
 * chain never reaches a node.
 */
export function assertStoachain(chain: unknown): "stoachain" {
  if (typeof chain === "string" && chain.trim() === SUPPORTED_CHAIN) {
    return SUPPORTED_CHAIN;
  }
  throw new PythiaUnsupportedChainError(
    `Unsupported chain: only "${SUPPORTED_CHAIN}" is served (got ${JSON.stringify(chain)})`,
  );
}

/**
 * Assert a required caller input is present and non-empty, returning its
 * trimmed value. Absent (`undefined`/`null`), empty, or whitespace-only input
 * throws the Phase-2 {@link PythiaValidationError} naming the field — the caller
 * must reject BEFORE any network read so a garbage Pact expression is never
 * sent to a node.
 */
export function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "") {
      return trimmed;
    }
  }
  throw new PythiaValidationError(
    `${field} is required and must be a non-empty string`,
  );
}
