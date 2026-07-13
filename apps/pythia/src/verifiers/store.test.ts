import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VerifierStore, normalizeBaseUrl } from "./store.js";

function freshStore(): { store: VerifierStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pythia-verifiers-"));
  return {
    store: new VerifierStore({ filePath: join(dir, "verifiers.json") }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("normalizeBaseUrl", () => {
  it("keeps only the origin — drops path, query, and trailing slash", () => {
    expect(normalizeBaseUrl("https://codex.ancientholdings.eu/")).toBe("https://codex.ancientholdings.eu");
    expect(normalizeBaseUrl("http://localhost:3005/apollo-verify?x=1")).toBe("http://localhost:3005");
    expect(normalizeBaseUrl("  https://x.test  ")).toBe("https://x.test");
  });
  it("rejects non-http(s) and malformed URLs", () => {
    expect(normalizeBaseUrl("ftp://x.test")).toBeNull();
    expect(normalizeBaseUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeBaseUrl("not a url")).toBeNull();
    expect(normalizeBaseUrl("")).toBeNull();
  });
});

describe("VerifierStore", () => {
  it("starts EMPTY — no seeded verifiers", () => {
    const { store, cleanup } = freshStore();
    expect(store.list()).toEqual([]);
    expect(store.enabled()).toEqual([]);
    cleanup();
  });

  it("adds a valid verifier and exposes only the public shape when enabled", () => {
    const { store, cleanup } = freshStore();
    const res = store.add({ label: "Mnemosyne", baseUrl: "https://codex.ancientholdings.eu/apollo-verify" });
    expect(res.ok).toBe(true);
    const pub = store.enabled();
    expect(pub).toHaveLength(1);
    expect(pub[0]).toEqual({
      id: expect.any(String),
      label: "Mnemosyne",
      baseUrl: "https://codex.ancientholdings.eu", // normalized to origin
    });
    expect(pub[0]).not.toHaveProperty("addedAt");
    expect(pub[0]).not.toHaveProperty("enabled");
    cleanup();
  });

  it("rejects a blank label, a bad URL, and a duplicate origin", () => {
    const { store, cleanup } = freshStore();
    expect(store.add({ label: "  ", baseUrl: "https://x.test" })).toMatchObject({ ok: false });
    expect(store.add({ label: "x", baseUrl: "ftp://x.test" })).toMatchObject({ ok: false });
    store.add({ label: "one", baseUrl: "https://dup.test" });
    expect(store.add({ label: "two", baseUrl: "https://dup.test/other" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("already exists"),
    });
    cleanup();
  });

  it("disable hides it from the public list; remove drops it entirely", () => {
    const { store, cleanup } = freshStore();
    const added = store.add({ label: "local", baseUrl: "http://localhost:3005" });
    const id = added.ok ? added.verifier.id : "";
    expect(store.setEnabled(id, false)).toBe(true);
    expect(store.enabled()).toEqual([]);
    expect(store.list()).toHaveLength(1); // still in the admin view
    expect(store.remove(id)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.remove("nope")).toBe(false);
    cleanup();
  });

  it("re-validates on load — drops non-object rows, bad URLs, and missing fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "pythia-verifiers-"));
    const path = join(dir, "v.json");
    // A hand-corrupted file: only the first row is a well-formed verifier.
    writeFileSync(
      path,
      JSON.stringify([
        { id: "ok", label: "Good", baseUrl: "https://good.test/apollo-verify", enabled: true, addedAt: "2026-01-01T00:00:00Z" },
        { id: "js", label: "Evil", baseUrl: "javascript:alert(1)", enabled: true }, // bad scheme → dropped
        { id: "nofields", enabled: true }, // missing label/baseUrl → dropped
        "not an object", // → dropped
        null, // → dropped
      ]),
    );
    const store = new VerifierStore({ filePath: path });
    const pub = store.enabled();
    expect(pub).toHaveLength(1);
    expect(pub[0]).toEqual({ id: "ok", label: "Good", baseUrl: "https://good.test" }); // re-normalized
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists across reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "pythia-verifiers-"));
    const path = join(dir, "v.json");
    const a = new VerifierStore({ filePath: path });
    a.add({ label: "keep", baseUrl: "https://keep.test" });
    const b = new VerifierStore({ filePath: path });
    expect(b.enabled().map((v) => v.baseUrl)).toEqual(["https://keep.test"]);
    rmSync(dir, { recursive: true, force: true });
  });
});
