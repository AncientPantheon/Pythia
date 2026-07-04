import { describe, it, expect } from "vitest";
import { assertChainId } from "./chain.js";
import { PythiaValidationError } from "./errors.js";

describe("assertChainId", () => {
  it("defaults an absent chain id to chain 0 (the spec default)", () => {
    expect(assertChainId(undefined)).toBe(0);
    expect(assertChainId(null)).toBe(0);
  });

  it("accepts an in-range integer as-is", () => {
    expect(assertChainId(0)).toBe(0);
    expect(assertChainId(3)).toBe(3);
    expect(assertChainId(9)).toBe(9);
  });

  it("parses a numeric string chain id to its integer value", () => {
    // A JSON body may carry chainId as "3"; the relay must coerce before use.
    expect(assertChainId("3")).toBe(3);
    expect(assertChainId("0")).toBe(0);
  });

  it("rejects an out-of-range chain id (Stoa has exactly chains 0-9)", () => {
    expect(() => assertChainId(10)).toThrow(PythiaValidationError);
    expect(() => assertChainId(-1)).toThrow(PythiaValidationError);
  });

  it("rejects a non-integer or garbage chain id before any network attempt", () => {
    expect(() => assertChainId(1.5)).toThrow(PythiaValidationError);
    expect(() => assertChainId("x")).toThrow(PythiaValidationError);
    expect(() => assertChainId({})).toThrow(PythiaValidationError);
  });
});
