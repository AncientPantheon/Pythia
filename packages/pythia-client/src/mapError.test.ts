import { describe, it, expect } from "vitest";
import { mapServiceError, isPythiaErrorEnvelope } from "./mapError.js";
import {
  PythiaClientError,
  PythiaValidationError,
  PythiaUnsupportedChainError,
  PythiaPoolExhaustedError,
} from "./errors.js";

describe("mapServiceError", () => {
  it("maps a 400 with code 'pythia_unsupported_chain' to PythiaUnsupportedChainError", () => {
    // Pythia's own envelopes are self-identifying via `code`; the client no
    // longer sniffs the human message to discriminate unsupported-chain.
    const err = mapServiceError(400, {
      code: "pythia_unsupported_chain",
      error: 'Unsupported chain: only "stoachain" is served (got "eth")',
    });
    expect(err).toBeInstanceOf(PythiaUnsupportedChainError);
    expect(err.message).toBe(
      'Unsupported chain: only "stoachain" is served (got "eth")',
    );
  });

  it("maps a 400 with code 'pythia_validation' to PythiaValidationError", () => {
    // A required-field 400 self-identifies as pythia_validation, independent of
    // its message text.
    const err = mapServiceError(400, {
      code: "pythia_validation",
      error: "tx is required and must be a non-empty string",
    });
    expect(err).toBeInstanceOf(PythiaValidationError);
    expect(err).not.toBeInstanceOf(PythiaUnsupportedChainError);
    expect(err.message).toBe("tx is required and must be a non-empty string");
  });

  it("maps a 400 with code 'pythia_upstream' to the base PythiaClientError", () => {
    // A node-rejected-input 400 surfaced by Pythia carries pythia_upstream; it
    // is a Pythia envelope but not a caller validation error.
    const err = mapServiceError(400, {
      code: "pythia_upstream",
      error: "upstream rejected request: bad account",
    });
    expect(err).toBeInstanceOf(PythiaClientError);
    expect(err).not.toBeInstanceOf(PythiaValidationError);
  });

  it("maps a 502 body with code 'pythia_pool_exhausted' preserving failures and chainId", () => {
    const failures = [
      { sourceId: "stoachain-primary", url: "https://primary", cause: "down" },
      { sourceId: "stoachain-fallback", url: "https://fallback", cause: "down" },
    ];
    const err = mapServiceError(502, {
      code: "pythia_pool_exhausted",
      error: "PythiaPoolExhaustedError",
      chainId: 4,
      failures,
    });
    expect(err).toBeInstanceOf(PythiaPoolExhaustedError);
    const pool = err as PythiaPoolExhaustedError;
    expect(pool.failures).toEqual(failures);
    expect(pool.chainId).toBe(4);
  });

  it("maps a 503 pool-exhausted body (code 'pythia_pool_exhausted') to PythiaPoolExhaustedError too", () => {
    // Pool exhaustion may surface as 502 or 503; both carry the same code.
    const err = mapServiceError(503, {
      code: "pythia_pool_exhausted",
      error: "PythiaPoolExhaustedError",
      failures: [],
    });
    expect(err).toBeInstanceOf(PythiaPoolExhaustedError);
  });

  it("falls back to the base PythiaClientError for an unrecognized status/body", () => {
    const err = mapServiceError(500, { error: "boom" });
    expect(err).toBeInstanceOf(PythiaClientError);
    expect(err).not.toBeInstanceOf(PythiaValidationError);
    expect(err).not.toBeInstanceOf(PythiaPoolExhaustedError);
  });
});

describe("isPythiaErrorEnvelope", () => {
  it("recognizes a Pythia-origin 400 by its `code` discriminator", () => {
    // Only Pythia's OWN envelopes carry a `code`; the relay uses this to decide
    // whether to remap or pass through.
    expect(
      isPythiaErrorEnvelope(400, {
        code: "pythia_validation",
        error: "Request body must be a JSON object",
      }),
    ).toBe(true);
  });

  it("does NOT treat a node-origin 400 {error:string} WITHOUT a code as a Pythia envelope", () => {
    // A node's own 400 forwarded verbatim by the relay has no `code`; it must be
    // passed through, not remapped to a Pythia validation error.
    expect(
      isPythiaErrorEnvelope(400, { error: "node says: invalid pact" }),
    ).toBe(false);
  });

  it("recognizes a pool-exhausted 502/503 by its `code`", () => {
    expect(
      isPythiaErrorEnvelope(502, {
        code: "pythia_pool_exhausted",
        error: "PythiaPoolExhaustedError",
        failures: [],
      }),
    ).toBe(true);
  });
});
