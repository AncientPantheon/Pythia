import { describe, it, expect } from "vitest";
import type { FetchImpl } from "../dial/index.js";
import {
  ORGAN_PACKAGES,
  readInstalledOrganVersion,
  fetchLatestOrganVersion,
  collectOrganVersions,
} from "./organVersions.js";

// A fetch stub returning a fixed npm packument (or a failure) — no network in tests.
function npmStub(distTagLatest: string | null, ok = true): FetchImpl {
  return (async () =>
    ({
      ok,
      status: ok ? 200 : 500,
      json: async () => ({ "dist-tags": distTagLatest ? { latest: distTagLatest } : {} }),
    }) as unknown as Response) as FetchImpl;
}

describe("organ version reporting", () => {
  it("lists the three automaton organs (Codex + Khronoton + Pythia's own connector), in order", () => {
    expect(ORGAN_PACKAGES.map((o) => o.key)).toEqual(["codex", "khronoton", "pythia-client"]);
    expect(ORGAN_PACKAGES.map((o) => o.pkg)).toEqual([
      "@ancientpantheon/codex",
      "@ancientpantheon/khronoton-core",
      "@ancientpantheon/pythia-client",
    ]);
  });

  it("reads the real installed version from node_modules (a dotted semver, not 'unknown')", () => {
    const v = readInstalledOrganVersion("@ancientpantheon/codex");
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("reads the real installed version of pythia-client, now that it's a declared dependency", () => {
    const v = readInstalledOrganVersion("@ancientpantheon/pythia-client");
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
    expect(v).not.toBe("unknown");
  });

  it("returns 'unknown' for a package that isn't installed", () => {
    expect(readInstalledOrganVersion("@ancientpantheon/does-not-exist")).toBe("unknown");
  });

  it("reads dist-tags.latest from the registry, null on failure", async () => {
    expect(await fetchLatestOrganVersion("x", { fetchImpl: npmStub("9.9.9") })).toBe("9.9.9");
    expect(await fetchLatestOrganVersion("x", { fetchImpl: npmStub(null, false) })).toBeNull();
  });

  it("collectOrganVersions flags updateAvailable only when the registry is strictly newer", async () => {
    // Force a huge available version so both organs read as update-available.
    const organs = await collectOrganVersions({ fetchImpl: npmStub("999.0.0") });
    expect(organs).toHaveLength(3);
    for (const o of organs) {
      expect(o.installed).toMatch(/^\d+\.\d+\.\d+/);
      expect(o.available).toBe("999.0.0");
      expect(o.updateAvailable).toBe(true);
      expect(typeof o.label).toBe("string");
      expect(o.pkg).toMatch(/^@ancientpantheon\//);
    }
    // Registry unreachable → available null, never an update.
    const offline = await collectOrganVersions({ fetchImpl: npmStub(null, false) });
    expect(offline.every((o) => o.available === null && o.updateAvailable === false)).toBe(true);
  });

  it("collectOrganVersions returns exactly 3 entries, in ORGAN_PACKAGES order, pythia-client third", async () => {
    const organs = await collectOrganVersions({ fetchImpl: npmStub("1.0.0") });
    expect(organs).toHaveLength(3);
    expect(organs.map((o) => o.key)).toEqual(["codex", "khronoton", "pythia-client"]);
    expect(organs[2].pkg).toBe("@ancientpantheon/pythia-client");
    expect(organs[2].label).toBe("Pythia");
  });
});
