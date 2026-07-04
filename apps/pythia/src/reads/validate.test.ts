import { describe, it, expect } from "vitest";
import {
  assertStoachain,
  requireNonEmpty,
  requirePactSafe,
  PythiaUnsupportedChainError,
  KADENA_NAMESPACE,
  TOKEN_ID_IGNIS,
} from "./index.js";
import { PythiaValidationError } from "../dial/index.js";

describe("assertStoachain", () => {
  it("returns the literal chain name for the supported chain", () => {
    // The reads layer serves exactly one chain; the guard narrows the caller's
    // unknown input to the "stoachain" literal so downstream code is type-safe.
    expect(assertStoachain("stoachain")).toBe("stoachain");
  });

  it("accepts a padded chain name by trimming before the literal check", () => {
    expect(assertStoachain("  stoachain  ")).toBe("stoachain");
  });

  it("rejects a different real chain name with PythiaUnsupportedChainError", () => {
    // A wrong-but-plausible chain (kadena) is the case a client SDK bug would
    // hit; it must surface as the typed unsupported-chain error, not a read.
    expect(() => assertStoachain("kadena")).toThrow(PythiaUnsupportedChainError);
  });

  it("rejects an empty string as unsupported (not a generic validation error)", () => {
    // Absent/empty chain is an unsupported-chain condition per the spec — it
    // must NOT be conflated with the required-input validation error.
    expect(() => assertStoachain("")).toThrow(PythiaUnsupportedChainError);
  });

  it("rejects undefined and null with PythiaUnsupportedChainError", () => {
    expect(() => assertStoachain(undefined)).toThrow(PythiaUnsupportedChainError);
    expect(() => assertStoachain(null)).toThrow(PythiaUnsupportedChainError);
  });

  it("sets a stable error name so the route layer can map it to a 400", () => {
    // The route matches on the typed class; pinning `name` documents the wire
    // contract the client SDK reads back.
    try {
      assertStoachain("btc");
    } catch (err) {
      expect((err as Error).name).toBe("PythiaUnsupportedChainError");
    }
  });
});

describe("requireNonEmpty", () => {
  it("returns the trimmed value for a real input", () => {
    // A real address/tx passes through so the caller can use the return value
    // directly, with surrounding whitespace stripped.
    expect(requireNonEmpty("  k:abc  ", "address")).toBe("k:abc");
  });

  it("rejects an empty string with PythiaValidationError naming the field", () => {
    // An empty required input must be rejected BEFORE any network read, with a
    // message that names which field was missing so the client can correct it.
    expect(() => requireNonEmpty("", "address")).toThrow(PythiaValidationError);
    expect(() => requireNonEmpty("", "address")).toThrow(/address/);
  });

  it("rejects a whitespace-only string as empty", () => {
    // "   " has no meaningful value; treating it as present would produce a
    // garbage Pact expression sent to the node.
    expect(() => requireNonEmpty("   ", "tx")).toThrow(PythiaValidationError);
  });

  it("rejects undefined and null with PythiaValidationError", () => {
    expect(() => requireNonEmpty(undefined, "tx")).toThrow(PythiaValidationError);
    expect(() => requireNonEmpty(null, "tx")).toThrow(PythiaValidationError);
  });

  it("reuses the Phase-2 PythiaValidationError type, not a new one", () => {
    // The route layer already maps PythiaValidationError → 400; reusing it keeps
    // one error→status contract rather than forking a second validation error.
    try {
      requireNonEmpty("", "address");
    } catch (err) {
      expect(err).toBeInstanceOf(PythiaValidationError);
      expect((err as Error).name).toBe("PythiaValidationError");
    }
  });
});

describe("requirePactSafe", () => {
  it("returns the trimmed value for a real k:-principal address", () => {
    // A canonical Kadena principal is entirely within the allowlist, so it
    // passes and is usable directly to build the Pact string literal.
    expect(requirePactSafe("  k:abc123  ", "address")).toBe("k:abc123");
  });

  it("accepts a real DPTF token id (letters, digits, dashes)", () => {
    // DPTF ids like GAS-8Nh-JO8JO4F5 must survive the allowlist unchanged, or
    // a legitimate token lookup would be wrongly rejected.
    expect(requirePactSafe("GAS-8Nh-JO8JO4F5", "token")).toBe(
      "GAS-8Nh-JO8JO4F5",
    );
  });

  it('rejects a value containing a double-quote (Pact string break-out)', () => {
    // A `"` closes the Pact string literal early; injecting it would let a
    // caller append arbitrary read-only Pact after the intended argument.
    expect(() => requirePactSafe('k:a" (read-something)', "address")).toThrow(
      PythiaValidationError,
    );
  });

  it("rejects a backslash and parentheses (Pact escape / expression chars)", () => {
    // `\` starts a Pact escape and `(` opens a new s-expression — both would let
    // the caller alter the shape of the code we send to the node.
    expect(() => requirePactSafe("k:a\\b", "address")).toThrow(
      PythiaValidationError,
    );
    expect(() => requirePactSafe("(coin.details)", "address")).toThrow(
      PythiaValidationError,
    );
  });

  it("rejects whitespace and newlines inside an otherwise-plausible value", () => {
    // Interior whitespace/newlines are not part of any real principal or token
    // id and are the vector for multi-expression injection.
    expect(() => requirePactSafe("k:a b", "address")).toThrow(
      PythiaValidationError,
    );
    expect(() => requirePactSafe("k:a\nb", "address")).toThrow(
      PythiaValidationError,
    );
  });

  it("still rejects an empty/whitespace value before the allowlist check", () => {
    // The non-empty guard runs first, so an empty field is a validation error
    // naming the field, exactly as requireNonEmpty would report it.
    expect(() => requirePactSafe("", "address")).toThrow(PythiaValidationError);
    expect(() => requirePactSafe("   ", "token")).toThrow(/token/);
  });
});

describe("replicated decode constants", () => {
  it("replicates the ouronet Pact namespace literal", () => {
    // Replicated locally (not imported) because the sibling constants barrel
    // transitively drags the network host-selection module into the graph.
    expect(KADENA_NAMESPACE).toBe("ouronet-ns");
  });

  it("replicates the IGNIS (gas) token id literal", () => {
    expect(TOKEN_ID_IGNIS).toBe("GAS-8Nh-JO8JO4F5");
  });
});
