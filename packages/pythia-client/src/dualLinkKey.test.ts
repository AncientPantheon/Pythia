import { describe, it, expect } from "vitest";
import { splitDualLinkKey, APOLLO_ACCOUNT_LEN, DUAL_LINK_BAR } from "./dualLinkKey.js";
import { PythiaConnectorValidationError } from "./connectorErrors.js";

// Real 162-char fixtures, same padding style used elsewhere in this package's
// tests: a distinguishing prefix (the codepoint the half must start with, plus
// a marker char) padded out to the fixed Apollo-account length.
const STANDARD = "₱.".padEnd(APOLLO_ACCOUNT_LEN, "a");
const SMART = "Π.".padEnd(APOLLO_ACCOUNT_LEN, "b");

describe("splitDualLinkKey", () => {
  it("round-trips a well-formed dual-link-key into its standard/smart halves", () => {
    // The whole point of this function: a UI form pastes one 325-char string
    // and needs the two halves back out, unchanged, in the right slots.
    const key = `${STANDARD}${DUAL_LINK_BAR}${SMART}`;
    expect(splitDualLinkKey(key)).toEqual({
      standardApollo: STANDARD,
      smartApollo: SMART,
    });
  });

  it("rejects a key whose total length isn't exactly 325 characters", () => {
    // Catches truncated/extended paste errors before any positional slicing
    // is even attempted on a string of the wrong shape.
    const tooShort = `${STANDARD}${DUAL_LINK_BAR}${SMART}`.slice(0, -1);
    expect(() => splitDualLinkKey(tooShort)).toThrow(PythiaConnectorValidationError);
    expect(() => splitDualLinkKey(tooShort)).toThrow(/expected 325 characters/);
  });

  it("rejects a key missing the separator at the fixed offset", () => {
    // A 325-char string that happens to have some other character at index
    // 162 (not "|") means the halves are misaligned — the length check alone
    // can't catch this, since length is unaffected by a single substitution.
    const noBar = `${STANDARD}x${SMART}`;
    expect(noBar.length).toBe(325);
    expect(() => splitDualLinkKey(noBar)).toThrow(PythiaConnectorValidationError);
    expect(() => splitDualLinkKey(noBar)).toThrow(/expected "\|" at position 162/);
  });

  it("rejects a key whose standard half doesn't start with ₱", () => {
    const badStandard = `${"x".repeat(APOLLO_ACCOUNT_LEN)}${DUAL_LINK_BAR}${SMART}`;
    expect(() => splitDualLinkKey(badStandard)).toThrow(PythiaConnectorValidationError);
    expect(() => splitDualLinkKey(badStandard)).toThrow(/standard half must start with ₱/);
  });

  it("rejects a key whose smart half doesn't start with Π", () => {
    const badSmart = `${STANDARD}${DUAL_LINK_BAR}${"y".repeat(APOLLO_ACCOUNT_LEN)}`;
    expect(() => splitDualLinkKey(badSmart)).toThrow(PythiaConnectorValidationError);
    expect(() => splitDualLinkKey(badSmart)).toThrow(/smart half must start with Π/);
  });

  it("catches a stray separator inside a half via the position check, even though total length is still 325", () => {
    // Insert a stray "|" at index 10 (inside what should be the standard
    // half) and drop the trailing character to keep the total length at
    // 325 — this shifts the REAL separator from index 162 to 163, so the
    // length check (check 1) alone would let this through; only the
    // position check (check 2) catches the misalignment.
    const wellFormed = `${STANDARD}${DUAL_LINK_BAR}${SMART}`;
    const shifted = `${wellFormed.slice(0, 10)}${DUAL_LINK_BAR}${wellFormed.slice(10, -1)}`;
    expect(shifted.length).toBe(325);
    expect(shifted[APOLLO_ACCOUNT_LEN]).not.toBe(DUAL_LINK_BAR);
    expect(() => splitDualLinkKey(shifted)).toThrow(PythiaConnectorValidationError);
    expect(() => splitDualLinkKey(shifted)).toThrow(/expected "\|" at position 162/);
  });
});
