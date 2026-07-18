import { describe, it, expect } from "vitest";
import { pondus, round3, CLASS_BASE } from "./pondus.js";

describe("pondus", () => {
  it("is just the classBase when there is no gas and no bytes", () => {
    expect(pondus({ classBase: CLASS_BASE.read, gasUsed: 0, responseBytes: 0 })).toBe(10);
    expect(pondus({ classBase: CLASS_BASE.poll, gasUsed: 0, responseBytes: 0 })).toBe(5);
  });

  it("adds sqrt(gasUsed)/2 — 500k gas contributes ~353.553 (handoff)", () => {
    const p = pondus({ classBase: 0, gasUsed: 500_000, responseBytes: 0 });
    expect(p).toBeCloseTo(Math.sqrt(500_000) / 2, 6);
    expect(round3(p)).toBe(353.553);
  });

  it("adds responseBytes/4096", () => {
    expect(pondus({ classBase: CLASS_BASE.poll, gasUsed: 0, responseBytes: 4096 })).toBe(6);
    expect(pondus({ classBase: 0, gasUsed: 0, responseBytes: 2048 })).toBe(0.5);
  });

  it("applies the sqrt PER REQUEST — sqrt(a)+sqrt(b) != sqrt(a+b)", () => {
    const a = pondus({ classBase: 0, gasUsed: 500_000, responseBytes: 0 });
    const b = pondus({ classBase: 0, gasUsed: 500_000, responseBytes: 0 });
    const combined = pondus({ classBase: 0, gasUsed: 1_000_000, responseBytes: 0 });
    // two 500k reads must weigh MORE than one 1M read (the whole reason it's per-request)
    expect(a + b).toBeGreaterThan(combined);
  });

  it("treats negative / non-finite gas or bytes as zero (a bad node field never inflates weight)", () => {
    expect(pondus({ classBase: 10, gasUsed: -5, responseBytes: -100 })).toBe(10);
    expect(pondus({ classBase: 10, gasUsed: Number.NaN, responseBytes: Number.POSITIVE_INFINITY })).toBe(10);
  });

  it("round3 rounds to 3 decimals", () => {
    expect(round3(363.55339)).toBe(363.553);
    expect(round3(10)).toBe(10);
    expect(round3(0.0002)).toBe(0);
  });
});
