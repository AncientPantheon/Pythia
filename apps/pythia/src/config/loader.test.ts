import { describe, it, expect } from "vitest";
import { loadPythiaConfig, PythiaConfigError } from "./loader.js";
import type { RawPythiaConfig } from "./types.js";

const validRaw = (): RawPythiaConfig => ({
  sources: [
    {
      id: "stoachain-primary",
      url: "https://node.stoachain.com",
      role: "primary",
      chain: "stoachain",
    },
    {
      id: "stoachain-fallback",
      url: "https://node2.stoachain.com",
      role: "fallback",
      chain: "stoachain",
    },
  ],
  connectors: [{ name: "StoaWallet", url: "https://wallet.stoachain.com" }],
  finalityDepth: 6,
});

describe("loadPythiaConfig", () => {
  it("loads a valid config and exposes typed sources, connectors, and finalityDepth", () => {
    // A well-formed config yields exactly the primary + fallback pair, the
    // connector list, and the finality depth the operator committed.
    const config = loadPythiaConfig(validRaw());

    expect(config.sources).toHaveLength(2);
    expect(config.sources.map((s) => s.role).sort()).toEqual([
      "fallback",
      "primary",
    ]);
    expect(config.sources.find((s) => s.role === "primary")?.url).toBe(
      "https://node.stoachain.com",
    );
    expect(config.connectors).toHaveLength(1);
    expect(config.connectors[0]?.name).toBe("StoaWallet");
    expect(config.finalityDepth).toBe(6);
  });

  it("defaults corsOrigins to an empty list when the field is absent", () => {
    // corsOrigins is optional; an absent field means "no allowlist" → the CORS
    // layer falls back to a permissive wildcard for the public read gateway.
    const raw = validRaw();
    delete (raw as { corsOrigins?: unknown }).corsOrigins;

    expect(loadPythiaConfig(raw).corsOrigins).toEqual([]);
  });

  it("loads a configured corsOrigins allowlist verbatim", () => {
    // When the operator pins origins, the loader passes them through so the CORS
    // layer can echo only those origins back.
    const raw = validRaw();
    (raw as { corsOrigins?: string[] }).corsOrigins = [
      "https://ouronet.ui",
      "https://wallet.stoachain.com",
    ];

    expect(loadPythiaConfig(raw).corsOrigins).toEqual([
      "https://ouronet.ui",
      "https://wallet.stoachain.com",
    ]);
  });

  it("defaults readGasLimit to 100M when the field is absent", () => {
    // readGasLimit is optional; absent means "use the generous dirty-read
    // default" so expensive reads are not gas-starved by an old low ceiling.
    const raw = validRaw();
    delete (raw as { readGasLimit?: unknown }).readGasLimit;

    expect(loadPythiaConfig(raw).readGasLimit).toBe(100_000_000);
  });

  it("loads a configured readGasLimit verbatim", () => {
    // When the operator pins a budget, the loader passes the exact integer
    // through so it becomes the per-read default the route applies.
    const raw = validRaw();
    (raw as { readGasLimit?: number }).readGasLimit = 250_000;

    expect(loadPythiaConfig(raw).readGasLimit).toBe(250_000);
  });

  it("rejects a readGasLimit that is not a positive integer", () => {
    // A zero, negative, or fractional budget is a boot-time config error, not a
    // silently coerced value.
    for (const bad of [0, -1, 1.5, "100" as unknown]) {
      const raw = validRaw();
      (raw as { readGasLimit?: unknown }).readGasLimit = bad;
      expect(() => loadPythiaConfig(raw)).toThrow(/readGasLimit/i);
    }
  });

  it("rejects a corsOrigins that is not an array of strings", () => {
    // A malformed allowlist (e.g. a bare string or a number entry) is a config
    // error surfaced at boot, not a silently ignored value.
    const raw = validRaw();
    (raw as { corsOrigins?: unknown }).corsOrigins = ["https://ok", 42];

    expect(() => loadPythiaConfig(raw)).toThrow(PythiaConfigError);
    expect(() => loadPythiaConfig(raw)).toThrow(/corsOrigins/i);
  });

  it("rejects a config with zero primary sources", () => {
    // The dial requires exactly one primary; zero leaves no node to lead with.
    const raw = validRaw();
    raw.sources[0]!.role = "fallback";

    expect(() => loadPythiaConfig(raw)).toThrow(PythiaConfigError);
    expect(() => loadPythiaConfig(raw)).toThrow(/primary/i);
  });

  it("rejects a config with more than one primary source", () => {
    // Two primaries is ambiguous — the dial cannot pick a leader.
    const raw = validRaw();
    raw.sources[1]!.role = "primary";

    expect(() => loadPythiaConfig(raw)).toThrow(PythiaConfigError);
    expect(() => loadPythiaConfig(raw)).toThrow(/primary/i);
  });

  it("rejects a config with zero fallback sources", () => {
    // Without a fallback the pool cannot survive the primary going dark.
    const raw = validRaw();
    raw.sources[1]!.role = "primary";
    raw.sources[0]!.role = "primary";
    // now two primaries and zero fallbacks — assert the fallback rule fires
    raw.sources[1]!.role = "fallback";
    raw.sources[1]!.role = "primary";

    expect(() => loadPythiaConfig(raw)).toThrow(PythiaConfigError);
  });

  it("rejects a config with more than one fallback source", () => {
    // More than one fallback is out of scope for the two-node MVP pool.
    const raw = validRaw();
    raw.sources.push({
      id: "stoachain-fallback-2",
      url: "https://node3.stoachain.com",
      role: "fallback",
      chain: "stoachain",
    });

    expect(() => loadPythiaConfig(raw)).toThrow(PythiaConfigError);
    expect(() => loadPythiaConfig(raw)).toThrow(/fallback/i);
  });

  it("rejects a non-https source url", () => {
    // Read traffic to operator nodes must be encrypted in transit.
    const raw = validRaw();
    raw.sources[0]!.url = "http://node.stoachain.com";

    expect(() => loadPythiaConfig(raw)).toThrow(PythiaConfigError);
    expect(() => loadPythiaConfig(raw)).toThrow(/https|url/i);
  });

  it("rejects a source url that carries a path (not origin-only)", () => {
    // A source is a node origin, not an endpoint — paths are appended by the dial.
    const raw = validRaw();
    raw.sources[0]!.url = "https://node.stoachain.com/rpc";

    expect(() => loadPythiaConfig(raw)).toThrow(PythiaConfigError);
    expect(() => loadPythiaConfig(raw)).toThrow(/origin|url/i);
  });

  it("rejects a malformed connector missing its name", () => {
    // A connector without a name cannot be rendered or routed.
    const raw = validRaw();
    (raw.connectors[0] as { name?: string }).name = undefined;

    expect(() => loadPythiaConfig(raw)).toThrow(PythiaConfigError);
    expect(() => loadPythiaConfig(raw)).toThrow(/connector/i);
  });

  it("rejects a malformed connector missing its url", () => {
    // A connector without a url has nowhere to point.
    const raw = validRaw();
    (raw.connectors[0] as { url?: string }).url = undefined;

    expect(() => loadPythiaConfig(raw)).toThrow(PythiaConfigError);
    expect(() => loadPythiaConfig(raw)).toThrow(/connector/i);
  });
});
