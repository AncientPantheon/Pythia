import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSodiumReady, parseMasterKey } from "./vault.js";
import { SealedStore } from "./sealedStore.js";

const KEY_A = Buffer.from(new Uint8Array(32).fill(3)).toString("base64");
const KEY_B = Buffer.from(new Uint8Array(32).fill(4)).toString("base64");

let dir: string;
const store = (key: string | undefined) =>
  new SealedStore({ dir, keyProvider: () => parseMasterKey(key) });

beforeAll(async () => {
  await ensureSodiumReady();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pythia-codexvault-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("SealedStore — set/get", () => {
  it("round-trips a value across a cold reload", () => {
    store(KEY_A).set("hubHmacSecret", "deadbeef01");
    expect(store(KEY_A).get("hubHmacSecret")).toBe("deadbeef01");
  });

  it("writes only ciphertext to disk (no plaintext)", () => {
    store(KEY_A).set("s", "PLAINTEXT_MARKER_3a3a");
    const raw = readFileSync(join(dir, "s.sealed"), "utf8");
    expect(raw).not.toContain("PLAINTEXT_MARKER_3a3a");
  });

  it("returns null for an absent entry", () => {
    expect(store(KEY_A).get("nope")).toBeNull();
  });
});

describe("SealedStore — locked / no key", () => {
  it("no master key → status empty, get null, set throws", () => {
    const s = new SealedStore({ dir, keyProvider: () => parseMasterKey(undefined) });
    expect(s.status().mode).toBe("empty");
    expect(s.get("x")).toBeNull();
    expect(() => s.set("x", "y")).toThrow();
  });

  it("a wrong key → get null and status locked (no crash)", () => {
    store(KEY_A).set("hubHmacSecret", "v");
    const wrong = store(KEY_B);
    expect(wrong.get("hubHmacSecret")).toBeNull();
    expect(wrong.status().mode).toBe("locked");
  });
});

describe("SealedStore — status", () => {
  it("reports sealed mode, count, names, and an 8-hex fingerprint", () => {
    const s = store(KEY_A);
    s.set("a", "1");
    s.set("b", "2");
    const st = s.status();
    expect(st.mode).toBe("sealed");
    expect(st.sealedCount).toBe(2);
    expect(st.names.sort()).toEqual(["a", "b"]);
    expect(st.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("SealedStore — rotateMasterKey (generic re-seal, automaton/02 §4)", () => {
  it("re-seals every entry under the new key; the old key no longer decrypts", () => {
    const s = store(KEY_A);
    s.set("a", "one");
    s.set("b", "two");
    const n = s.rotateMasterKey(parseMasterKey(KEY_A), parseMasterKey(KEY_B));
    expect(n).toBe(2);
    // new key reads both; old key reads neither.
    expect(store(KEY_B).get("a")).toBe("one");
    expect(store(KEY_B).get("b")).toBe("two");
    expect(store(KEY_A).get("a")).toBeNull();
  });

  it("throws on a wrong OLD key WITHOUT dropping data (abort before any write)", () => {
    const s = store(KEY_A);
    s.set("keep", "safe");
    expect(() => s.rotateMasterKey(parseMasterKey(KEY_B), parseMasterKey(KEY_A))).toThrow();
    expect(store(KEY_A).get("keep")).toBe("safe"); // intact under the original key
  });
});

describe("SealedStore — clear", () => {
  it("removes every sealed entry", () => {
    const s = store(KEY_A);
    s.set("a", "1");
    s.clear();
    expect(s.status().sealedCount).toBe(0);
    expect(readdirSync(dir).filter((f) => f.endsWith(".sealed"))).toHaveLength(0);
  });
});
