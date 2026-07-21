import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PythEpochStore, parseEpochResult, PYTH_EPOCH_DEFAULT_MS } from "./epoch.js";

const tmp: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "pyth-epoch-"));
  tmp.push(dir);
  return join(dir, "epoch.json");
}
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CHAIN_ISO = "2026-07-21T00:00:00.000Z";
const CHAIN_MS = Date.parse(CHAIN_ISO);

describe("parseEpochResult", () => {
  it("reads a Pact time object { time: ISO }", () => {
    expect(parseEpochResult({ time: CHAIN_ISO })).toBe(CHAIN_MS);
    expect(parseEpochResult({ timep: CHAIN_ISO })).toBe(CHAIN_MS);
  });
  it("reads a bare ISO string", () => {
    expect(parseEpochResult(CHAIN_ISO)).toBe(CHAIN_MS);
  });
  it("returns null for junk", () => {
    expect(parseEpochResult(null)).toBeNull();
    expect(parseEpochResult({ nope: 1 })).toBeNull();
    expect(parseEpochResult("not-a-date")).toBeNull();
  });
});

describe("PythEpochStore", () => {
  it("defaults to the hardcoded epoch until a chain read succeeds", () => {
    const s = new PythEpochStore({ filePath: scratch() });
    expect(s.epochMs()).toBe(PYTH_EPOCH_DEFAULT_MS);
    expect(s.status().source).toBe("default");
    expect(s.status().readAt).toBeNull();
  });

  it("resolve() reads from chain, caches, and reports source=chain + a readAt", async () => {
    const s = new PythEpochStore({ filePath: scratch(), reader: async () => CHAIN_MS });
    await s.resolve();
    expect(s.epochMs()).toBe(CHAIN_MS);
    const st = s.status();
    expect(st.source).toBe("chain");
    expect(st.iso).toBe(CHAIN_ISO);
    expect(typeof st.readAt).toBe("string");
  });

  it("a failed chain read leaves the default in place (source stays default)", async () => {
    const s = new PythEpochStore({ filePath: scratch(), reader: async () => null });
    await s.resolve();
    expect(s.epochMs()).toBe(PYTH_EPOCH_DEFAULT_MS);
    expect(s.status().source).toBe("default");
  });

  it("persists the chain value and reloads it as source=cached on the next boot", async () => {
    const file = scratch();
    const a = new PythEpochStore({ filePath: file, reader: async () => CHAIN_MS });
    await a.resolve();
    const b = new PythEpochStore({ filePath: file });
    expect(b.epochMs()).toBe(CHAIN_MS);
    expect(b.status().source).toBe("cached"); // chain-read on a prior boot
    expect(b.status().readAt).toBeTruthy();
  });
});
