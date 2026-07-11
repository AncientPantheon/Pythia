import { describe, it, expect } from "vitest";
import { buildChallengeMessage, VERIFY_DOMAIN } from "./canonicalMessage.js";

describe("buildChallengeMessage", () => {
  it("builds the exact 4-line canonical message the verifier must mirror", () => {
    // Byte-exact: the verifier signs this string and Pythia verifies it. Any
    // drift breaks every verification, so pin it literally.
    expect(buildChallengeMessage({ apollo: "₱.abc", nonce: "deadbeef" })).toBe(
      "Pythia · Apollo key ownership\napollo: ₱.abc\nnonce: deadbeef\ndomain: pythia.ancientholdings.eu",
    );
  });

  it("defaults to the Pythia domain — distinct from the hub's ancientholdings.eu", () => {
    // Domain separation: an Ouronet-account verification signature (hub domain)
    // must not be replayable as a Pythia Apollo proof.
    expect(VERIFY_DOMAIN).toBe("pythia.ancientholdings.eu");
    expect(buildChallengeMessage({ apollo: "Π.x", nonce: "n" })).toContain(
      "domain: pythia.ancientholdings.eu",
    );
  });

  it("honours an explicit domain override", () => {
    expect(buildChallengeMessage({ apollo: "₱.a", nonce: "n", domain: "example.test" })).toContain(
      "domain: example.test",
    );
  });
});
