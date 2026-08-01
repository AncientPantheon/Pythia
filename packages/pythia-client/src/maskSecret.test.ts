import { describe, it, expect } from "vitest";
import { maskSecret } from "./maskSecret.js";

describe("maskSecret", () => {
  it("masks a realistic pk_eph_...-shaped secret to exactly first7...last7", () => {
    // The whole point of this helper: an admin panel (or any future consumer)
    // must never render a full ephemeral secret — this proves the exact
    // masked string a real 39-char secret produces, not just its shape.
    const secret = "pk_eph_abcdefghijklmnopqrstuvwxyzABCDEF";
    expect(secret.length).toBe(39);
    expect(maskSecret(secret)).toBe("pk_eph_...zABCDEF");
  });

  it("masks a string exactly at the 14-char boundary without overlap", () => {
    // At exactly 14 chars, slice(0,7) and slice(-7) are adjacent, not
    // overlapping — this is the boundary where masking first becomes valid.
    const secret = "abcdefghijklmn";
    expect(secret.length).toBe(14);
    expect(maskSecret(secret)).toBe("abcdefg...hijklmn");
  });

  it("returns a 13-char string (one under the boundary) unchanged", () => {
    // Catches the exact off-by-one this helper exists to prevent: below the
    // boundary, masking would produce overlapping/negative-slice garbage.
    const secret = "abcdefghijklm";
    expect(secret.length).toBe(13);
    expect(maskSecret(secret)).toBe("abcdefghijklm");
  });

  it("returns the empty string unchanged", () => {
    // A degenerate input must never produce "..." or throw.
    expect(maskSecret("")).toBe("");
  });
});
