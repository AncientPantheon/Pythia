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

/**
 * Conservative allowlist for any caller value that gets interpolated into a Pact
 * string literal (an address or a DPTF token id). Accepts letters, digits, and
 * the punctuation that appears in real Kadena principals (`k:`/`w:`/`r:`), hex
 * accounts, and DPTF token ids (`GAS-8Nh-JO8JO4F5`): colon, dot, underscore,
 * hyphen. It deliberately rejects `"`, `\`, `(`, `)`, whitespace, newlines, and
 * control characters — the exact set that could close the Pact string literal
 * and inject additional read-only Pact.
 */
const PACT_SAFE = /^[A-Za-z0-9:._-]+$/;

/**
 * Assert a required caller input is present AND cannot break out of the Pact
 * string literal it will be interpolated into. Runs the {@link requireNonEmpty}
 * check first (naming the field on empty), then rejects any value outside the
 * conservative {@link PACT_SAFE} allowlist with {@link PythiaValidationError}.
 * The caller must run this BEFORE building any Pact expression so a break-out
 * value never reaches a node.
 */
export function requirePactSafe(value: unknown, field: string): string {
  const trimmed = requireNonEmpty(value, field);
  if (PACT_SAFE.test(trimmed)) {
    return trimmed;
  }
  throw new PythiaValidationError(
    `${field} contains characters that are not allowed`,
  );
}
