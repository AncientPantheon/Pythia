import { describe, it, expect } from "vitest";
import { loadReporters } from "./reporters.js";

describe("loadReporters", () => {
  it("parses a comma-separated list into a Set", () => {
    expect(loadReporters("dalos,hub,oracle")).toEqual(new Set(["dalos", "hub", "oracle"]));
  });
  it("trims whitespace and skips empty entries", () => {
    expect(loadReporters(" dalos , , hub ")).toEqual(new Set(["dalos", "hub"]));
  });
  it("returns an empty Set for an empty or missing value (ingress closed by default)", () => {
    expect(loadReporters("")).toEqual(new Set());
    expect(loadReporters(undefined)).toEqual(new Set());
  });
});
