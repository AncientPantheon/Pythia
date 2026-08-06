import { describe, it, expect } from "vitest";
import { pondus, CLASS_BASE } from "./pondus.js";

describe("pondus (shared)", () => {
  it("is just the classBase with no gas and no bytes", () => {
    expect(pondus({ classBase: CLASS_BASE.read, gasUsed: 0, responseBytes: 0 })).toBe(10);
    expect(pondus({ classBase: CLASS_BASE.poll, gasUsed: 0, responseBytes: 0 })).toBe(5);
  });

  it("adds sqrt(gasUsed)/2 per request", () => {
    const p = pondus({ classBase: 0, gasUsed: 500_000, responseBytes: 0 });
    expect(p).toBeCloseTo(Math.sqrt(500_000) / 2, 6);
  });

  it("adds responseBytes/4096", () => {
    expect(pondus({ classBase: CLASS_BASE.poll, gasUsed: 0, responseBytes: 4096 })).toBe(6);
    expect(pondus({ classBase: 0, gasUsed: 0, responseBytes: 2048 })).toBe(0.5);
  });

  it("guards against negative/NaN gas and bytes (never inflates)", () => {
    expect(pondus({ classBase: 10, gasUsed: -5, responseBytes: -100 })).toBe(10);
    expect(pondus({ classBase: 10, gasUsed: NaN, responseBytes: NaN })).toBe(10);
  });

  it("classBase read=10, poll=5", () => {
    expect(CLASS_BASE.read).toBe(10);
    expect(CLASS_BASE.poll).toBe(5);
  });
});
