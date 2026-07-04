import { describe, it, expect } from "vitest";
import {
  PythiaClientError,
  PythiaValidationError,
  PythiaUnsupportedChainError,
  PythiaPoolExhaustedError,
} from "./errors.js";

describe("client error taxonomy", () => {
  it("PythiaClientError is the shared instanceof root for consumers", () => {
    // A consumer that catches the base class must catch every subclass — this is
    // the whole point of adding a base the flat service taxonomy lacks.
    const validation = new PythiaValidationError("tx is required");
    const unsupported = new PythiaUnsupportedChainError("Unsupported chain: x");
    const exhausted = new PythiaPoolExhaustedError({ failures: [] });

    for (const err of [validation, unsupported, exhausted]) {
      expect(err).toBeInstanceOf(PythiaClientError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it("sets a wire-stable name equal to each class name", () => {
    // `name` is how a consumer identifies the condition without importing the
    // class (structured logging / serialization) — it must match the class.
    expect(new PythiaClientError("x").name).toBe("PythiaClientError");
    expect(new PythiaValidationError("x").name).toBe("PythiaValidationError");
    expect(new PythiaUnsupportedChainError("x").name).toBe(
      "PythiaUnsupportedChainError",
    );
    expect(new PythiaPoolExhaustedError({ failures: [] }).name).toBe(
      "PythiaPoolExhaustedError",
    );
  });

  it("preserves the message on each error", () => {
    expect(new PythiaValidationError("tx is required").message).toBe(
      "tx is required",
    );
    expect(
      new PythiaUnsupportedChainError('Unsupported chain: got "eth"').message,
    ).toBe('Unsupported chain: got "eth"');
  });

  it("PythiaPoolExhaustedError carries the failures array and optional chainId", () => {
    // The 502 body's structural payload — a consumer inspects per-source causes
    // and the chain scope, so both must survive construction unchanged.
    const failures = [
      { sourceId: "stoachain-primary", url: "https://primary", cause: "down" },
      { sourceId: "stoachain-fallback", url: "https://fallback", cause: "down" },
    ];
    const err = new PythiaPoolExhaustedError({ failures, chainId: 3 });

    expect(err.failures).toEqual(failures);
    expect(err.chainId).toBe(3);
  });

  it("PythiaPoolExhaustedError leaves chainId undefined when not supplied", () => {
    const err = new PythiaPoolExhaustedError({ failures: [] });
    expect(err.chainId).toBeUndefined();
    expect(err.failures).toEqual([]);
  });
});
