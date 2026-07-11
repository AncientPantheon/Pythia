import { describe, it, expect } from "vitest";
import { buildChallengeMessage, RP } from "./canonicalMessage.js";

describe("buildChallengeMessage", () => {
  it("builds the exact 4-line generic canonical message the verifier must mirror", () => {
    // Byte-exact: the verifier signs this string and the RP verifies it. Any
    // drift breaks every verification, so pin it literally.
    expect(buildChallengeMessage({ apollo: "₱.abc", nonce: "deadbeef" })).toBe(
      "Apollo ownership proof\napollo: ₱.abc\nnonce: deadbeef\nrp: pythia.ancientholdings.eu",
    );
  });

  it("defaults to Pythia's rp, which scopes (domain-separates) its proofs", () => {
    // rp scoping: a proof signed for another relying party can't be replayed as a
    // Pythia proof (different `rp:` line → different message → verify fails).
    expect(RP).toBe("pythia.ancientholdings.eu");
    expect(buildChallengeMessage({ apollo: "Π.x", nonce: "n" })).toContain(
      "rp: pythia.ancientholdings.eu",
    );
  });

  it("honours an explicit rp override (a different consumer)", () => {
    expect(buildChallengeMessage({ apollo: "₱.a", nonce: "n", rp: "aletheia.example" })).toContain(
      "rp: aletheia.example",
    );
  });
});
