import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SealedVault } from "./sealedVault.js";

let dir: string;
const path = () => join(dir, "vault.json");
const open = (masterKey?: string) => new SealedVault({ filePath: path(), masterKey });

const KEY = "correct horse battery staple — master key A";
const KEY_B = "a different master key B";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pythia-vault-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("SealedVault — seal/unseal", () => {
  it("round-trips a secret through disk under the master key", () => {
    open(KEY).set("hubHmacSecret", "deadbeef0123");
    // A fresh instance (cold load) with the same key must unseal it.
    expect(open(KEY).get("hubHmacSecret")).toBe("deadbeef0123");
  });

  it("returns null for an unknown name", () => {
    expect(open(KEY).get("nope")).toBeNull();
  });

  it("never writes the plaintext secret to the persisted file", () => {
    open(KEY).set("hubHmacSecret", "PLAINTEXT_MARKER_9f9f");
    const raw = readFileSync(path(), "utf8");
    expect(raw).not.toContain("PLAINTEXT_MARKER_9f9f");
  });
});

describe("SealedVault — locked / wrong key", () => {
  it("a vault with no master key is locked → get() is null, set() throws", () => {
    const v = open(undefined);
    expect(v.status().mode).toBe("empty");
    expect(v.get("x")).toBeNull();
    expect(() => v.set("x", "y")).toThrow();
  });

  it("a wrong master key cannot decrypt existing blobs → get() is null (no crash)", () => {
    open(KEY).set("hubHmacSecret", "secretValue");
    const wrong = open(KEY_B);
    expect(wrong.get("hubHmacSecret")).toBeNull();
    expect(wrong.status().mode).toBe("locked");
  });
});

describe("SealedVault — status + fingerprint", () => {
  it("empty when no key, sealed with a count + fingerprint once populated", () => {
    expect(open(undefined).status()).toMatchObject({ mode: "empty", unlocked: false, sealedCount: 0 });
    const v = open(KEY);
    expect(v.status()).toMatchObject({ mode: "sealed", unlocked: true, sealedCount: 0 });
    v.set("hubHmacSecret", "s1");
    const st = v.status();
    expect(st.mode).toBe("sealed");
    expect(st.sealedCount).toBe(1);
    expect(st.names).toContain("hubHmacSecret");
    expect(st.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it("fingerprint is stable per key, differs across keys, and is not the key", () => {
    const fpA = open(KEY).status().fingerprint;
    const fpA2 = open(KEY).status().fingerprint;
    const fpB = open(KEY_B).status().fingerprint;
    expect(fpA).toBe(fpA2);
    expect(fpA).not.toBe(fpB);
    expect(fpA).not.toContain(KEY.slice(0, 8));
  });
});

describe("SealedVault — rotateMasterKey + clear", () => {
  it("re-seals every blob under the new key so the old key no longer decrypts", () => {
    open(KEY).set("hubHmacSecret", "rotateMe");
    const v = open(KEY);
    v.rotateMasterKey(KEY, KEY_B);
    // The SAME instance stays coherent (adopts the new key) ...
    expect(v.get("hubHmacSecret")).toBe("rotateMe");
    expect(v.status().mode).toBe("sealed");
    // ... and on disk: the new key reads it, the old key can't.
    expect(open(KEY_B).get("hubHmacSecret")).toBe("rotateMe");
    expect(open(KEY).get("hubHmacSecret")).toBeNull();
  });

  it("throws on a wrong old key WITHOUT dropping the sealed creds", () => {
    open(KEY).set("hubHmacSecret", "keepMe");
    const v = open(KEY);
    expect(() => v.rotateMasterKey(KEY_B, "some new key")).toThrow();
    // The data survives intact under the ORIGINAL key.
    expect(open(KEY).get("hubHmacSecret")).toBe("keepMe");
  });

  it("clear() deletes every sealed blob", () => {
    const v = open(KEY);
    v.set("a", "1");
    v.set("b", "2");
    v.clear();
    expect(v.status().sealedCount).toBe(0);
    expect(open(KEY).get("a")).toBeNull();
  });
});
