import { describe, it, expect } from "vitest";
import { loadConfigFromDisk } from "../src/config/index.js";

describe("checked-in pythia.config.json", () => {
  it("loads and validates the seeded two-node StoaChain pool", () => {
    // The committed config must satisfy the loader's invariants at boot: exactly
    // one primary (node1.stoachain.com) and one fallback (node2.stoachain.com).
    const config = loadConfigFromDisk();

    const primary = config.sources.find((s) => s.role === "primary");
    const fallback = config.sources.find((s) => s.role === "fallback");

    expect(primary?.url).toBe("https://node1.stoachain.com");
    expect(fallback?.url).toBe("https://node2.stoachain.com");
    expect(primary?.chain).toBe("stoachain");
    expect(config.finalityDepth).toBe(6);
    // The committed pool ships an empty CORS allowlist → the gateway serves a
    // permissive wildcard for public browser reads until an operator pins origins.
    expect(config.corsOrigins).toEqual([]);
  });
});
