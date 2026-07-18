import { describe, it, expect } from "vitest";
import { fetchAvailableVersion, isNewer } from "./versionInfo.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("fetchAvailableVersion", () => {
  it("returns the .version from the fetched package.json", async () => {
    const fetchImpl = (async () => jsonResponse({ version: "1.12.0", name: "pythia" })) as unknown as typeof fetch;
    expect(await fetchAvailableVersion({ fetchImpl })).toBe("1.12.0");
  });

  it("returns null on a non-2xx (repo/network hiccup) — never throws", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchAvailableVersion({ fetchImpl })).toBeNull();
  });

  it("returns null on malformed JSON or a missing version field", async () => {
    const bad = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    expect(await fetchAvailableVersion({ fetchImpl: bad })).toBeNull();
    const noVer = (async () => jsonResponse({ name: "pythia" })) as unknown as typeof fetch;
    expect(await fetchAvailableVersion({ fetchImpl: noVer })).toBeNull();
  });

  it("returns null when the fetch rejects (timeout/offline)", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await fetchAvailableVersion({ fetchImpl })).toBeNull();
  });
});

describe("isNewer", () => {
  it("is true only when available is a higher semver than installed", () => {
    expect(isNewer("1.12.0", "1.11.0")).toBe(true);
    expect(isNewer("1.11.1", "1.11.0")).toBe(true);
    expect(isNewer("2.0.0", "1.99.9")).toBe(true);
  });
  it("is false when equal or when installed is newer", () => {
    expect(isNewer("1.11.0", "1.11.0")).toBe(false);
    expect(isNewer("1.11.0", "1.12.0")).toBe(false); // installed ahead (edge)
  });
  it("is false on unparseable input rather than throwing", () => {
    expect(isNewer("garbage", "1.11.0")).toBe(false);
  });
});
