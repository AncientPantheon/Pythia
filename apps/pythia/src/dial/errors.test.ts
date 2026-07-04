import { describe, it, expect } from "vitest";
import { PythiaPoolExhaustedError } from "./errors.js";

describe("PythiaPoolExhaustedError", () => {
  it("carries every per-source failure in primary-then-fallback attempt order, preserving each cause", () => {
    // The HTTP layer renders these failures into the 502/503 body, so order
    // and cause identity must survive construction unchanged.
    const primaryCause = new TypeError("Failed to fetch");
    const fallbackCause = new Error("ECONNREFUSED");
    const err = new PythiaPoolExhaustedError({
      failures: [
        { sourceId: "stoachain-primary", url: "https://a", cause: primaryCause },
        { sourceId: "stoachain-fallback", url: "https://b", cause: fallbackCause },
      ],
      chainId: 3,
    });

    expect(err.failures).toHaveLength(2);
    expect(err.failures[0].sourceId).toBe("stoachain-primary");
    expect(err.failures[0].cause).toBe(primaryCause);
    expect(err.failures[1].sourceId).toBe("stoachain-fallback");
    expect(err.failures[1].cause).toBe(fallbackCause);
    expect(err.chainId).toBe(3);
  });

  it("is a real Error subclass with a stable name so route-layer catch can classify it", () => {
    const err = new PythiaPoolExhaustedError({ failures: [] });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PythiaPoolExhaustedError);
    expect(err.name).toBe("PythiaPoolExhaustedError");
  });

  it("leaves chainId undefined when not supplied (reads that are not chain-scoped)", () => {
    const err = new PythiaPoolExhaustedError({
      failures: [{ sourceId: "p", url: "https://a", cause: new Error("x") }],
    });
    expect(err.chainId).toBeUndefined();
  });
});
