import { describe, it, expect, vi, afterEach } from "vitest";
import { loadConsumerMap, consumerFor } from "./consumers.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PYTHIA_API_KEYS;
});

describe("loadConsumerMap", () => {
  it("parses a JSON array of {name,key} into a Map<key,name>", () => {
    // The deploy-time secret is a JSON array; each entry maps a caller's secret
    // key to the human-readable consumer name analytics attributes traffic to.
    const map = loadConsumerMap(
      JSON.stringify([
        { name: "OuronetUI", key: "secret-a" },
        { name: "Aletheia", key: "secret-b" },
      ]),
    );

    expect(map.get("secret-a")).toBe("OuronetUI");
    expect(map.get("secret-b")).toBe("Aletheia");
    expect(map.size).toBe(2);
  });

  it("reads from process.env.PYTHIA_API_KEYS when no argument is passed", () => {
    // At boot the map is loaded from the env secret; the raw string is optional
    // so the same loader serves both the env path and injected-string tests.
    process.env.PYTHIA_API_KEYS = JSON.stringify([{ name: "Env", key: "k1" }]);

    expect(loadConsumerMap().get("k1")).toBe("Env");
  });

  it("returns an empty map when the env is missing (no throw)", () => {
    // A deploy without the secret must still serve — analytics degrades to
    // attributing everything to "direct" rather than crashing the gateway.
    delete process.env.PYTHIA_API_KEYS;

    expect(loadConsumerMap().size).toBe(0);
  });

  it("returns an empty map and warns once on invalid JSON (no throw)", () => {
    // Malformed secret config must not take down the boot; it logs a single
    // warning and falls back to an empty (all-'direct') attribution map.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const map = loadConsumerMap("{not json");

    expect(map.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("ignores entries that are missing a name or key", () => {
    // A partial entry has no usable mapping, so it is skipped rather than
    // producing an undefined name or key in the attribution map.
    const map = loadConsumerMap(
      JSON.stringify([
        { name: "Good", key: "ok" },
        { name: "NoKey" },
        { key: "no-name" },
      ]),
    );

    expect(map.size).toBe(1);
    expect(map.get("ok")).toBe("Good");
  });
});

describe("consumerFor", () => {
  it("returns the mapped name for a known key", () => {
    // A request carrying a registered key is attributed to that consumer.
    const map = new Map([["secret-a", "OuronetUI"]]);
    expect(consumerFor(map, "secret-a")).toBe("OuronetUI");
  });

  it("returns 'direct' for an unknown or absent key", () => {
    // Unregistered or keyless traffic is bucketed as anonymous "direct" usage.
    const map = new Map([["secret-a", "OuronetUI"]]);
    expect(consumerFor(map, "nope")).toBe("direct");
    expect(consumerFor(map, undefined)).toBe("direct");
  });
});
