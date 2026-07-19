import { describe, it, expect, beforeAll } from "vitest";
import sodium from "libsodium-wrappers";
import {
  ensureSodiumReady,
  parseMasterKey,
  sealWithKey,
  unsealWithKey,
  seal,
  unseal,
} from "./vault.js";

// A valid 32-byte master key, base64 (the canonical automaton/02 format).
const KEY_A = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const KEY_B = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");

beforeAll(async () => {
  await ensureSodiumReady();
});

describe("parseMasterKey", () => {
  it("decodes a 32-byte base64 key", () => {
    expect(parseMasterKey(KEY_A)).toHaveLength(32);
  });
  it("throws when unset", () => {
    expect(() => parseMasterKey(undefined)).toThrow(/PYTHIA_MASTER_KEY/);
  });
  it("throws when the decoded length is not 32 bytes", () => {
    const short = Buffer.from(new Uint8Array(16)).toString("base64");
    expect(() => parseMasterKey(short)).toThrow(/32 bytes/);
  });
});

describe("sealWithKey / unsealWithKey", () => {
  it("round-trips a value under the same key", () => {
    const key = parseMasterKey(KEY_A);
    const sealed = sealWithKey(key, "deadbeef-secret");
    expect(unsealWithKey(key, sealed)).toBe("deadbeef-secret");
  });

  it("a different key cannot open the box (throws)", () => {
    const sealed = sealWithKey(parseMasterKey(KEY_A), "secretValue");
    expect(() => unsealWithKey(parseMasterKey(KEY_B), sealed)).toThrow();
  });

  it("seals with a fresh random nonce each time (ciphertext differs)", () => {
    const key = parseMasterKey(KEY_A);
    expect(sealWithKey(key, "same")).not.toBe(sealWithKey(key, "same"));
  });

  it("the sealed string carries no plaintext", () => {
    const sealed = sealWithKey(parseMasterKey(KEY_A), "PLAINTEXT_MARKER_5f5f");
    expect(sealed).not.toContain("PLAINTEXT_MARKER_5f5f");
  });

  it("uses libsodium crypto_secretbox (nonce ‖ ciphertext, base64)", () => {
    const sealed = sealWithKey(parseMasterKey(KEY_A), "x");
    const raw = Buffer.from(sealed, "base64");
    // 24-byte nonce + at least the 16-byte MAC
    expect(raw.length).toBeGreaterThanOrEqual(sodium.crypto_secretbox_NONCEBYTES + 16);
  });
});

describe("seal / unseal (env master key)", () => {
  it("round-trips using PYTHIA_MASTER_KEY", async () => {
    const prev = process.env.PYTHIA_MASTER_KEY;
    process.env.PYTHIA_MASTER_KEY = KEY_A;
    try {
      expect(await unseal(await seal("via-env"))).toBe("via-env");
    } finally {
      process.env.PYTHIA_MASTER_KEY = prev;
    }
  });
});
