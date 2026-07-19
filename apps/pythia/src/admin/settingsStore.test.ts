import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "./settingsStore.js";
import { SealedStore } from "../codex/sealedStore.js";
import { ensureSodiumReady, parseMasterKey } from "../codex/vault.js";

let dir: string;
const fresh = () => new SettingsStore({ filePath: join(dir, "settings.json") });

const VKEY = Buffer.from(new Uint8Array(32).fill(11)).toString("base64");
const VKEY2 = Buffer.from(new Uint8Array(32).fill(22)).toString("base64");
const openVault = (masterKey?: string) =>
  new SealedStore({ dir: join(dir, "vault"), keyProvider: () => parseMasterKey(masterKey) });
const sealed = (masterKey: string | undefined = VKEY) =>
  new SettingsStore({ filePath: join(dir, "settings.json"), vault: openVault(masterKey) });

beforeAll(async () => {
  await ensureSodiumReady();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pythia-settings-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("SettingsStore hub config", () => {
  it("starts empty — no secret, default base URL, hubConfig null", () => {
    const s = fresh();
    expect(s.hasSecret()).toBe(false);
    expect(s.hubBaseUrl()).toBe("https://ancientholdings.eu");
    expect(s.hubConfig()).toBeNull();
  });

  it("returns a HubConfig once a secret is set, stripping a trailing slash", () => {
    const s = fresh();
    s.setHubConfig({ hubBaseUrl: "https://hub.test/", hmacSecret: "deadbeef" });
    expect(s.hasSecret()).toBe(true);
    expect(s.hubConfig()).toEqual({ baseUrl: "https://hub.test", secret: "deadbeef" });
  });

  it("leaves the secret unchanged when hmacSecret is omitted (write-only update)", () => {
    const s = fresh();
    s.setHubConfig({ hmacSecret: "sec1" });
    s.setHubConfig({ hubBaseUrl: "https://other.test" }); // no hmacSecret → keep it
    expect(s.hubConfig()).toEqual({ baseUrl: "https://other.test", secret: "sec1" });
  });

  it("clears the secret on an empty string (disables the feed)", () => {
    const s = fresh();
    s.setHubConfig({ hmacSecret: "sec1" });
    s.setHubConfig({ hmacSecret: "" });
    expect(s.hasSecret()).toBe(false);
    expect(s.hubConfig()).toBeNull();
  });

  it("persists across reloads (survives a restart)", () => {
    fresh().setHubConfig({ hubBaseUrl: "https://hub.test", hmacSecret: "abc123" });
    const reloaded = fresh();
    expect(reloaded.hubConfig()).toEqual({ baseUrl: "https://hub.test", secret: "abc123" });
  });
});

describe("SettingsStore — sealed vault (master key present)", () => {
  it("stores the hub secret through the vault and reads it back across reloads", () => {
    sealed().setHubConfig({ hubBaseUrl: "https://hub.test", hmacSecret: "sealedSecret1" });
    // A fresh store + fresh vault over the SAME files + key unseals it.
    expect(sealed().hubConfig()).toEqual({
      baseUrl: "https://hub.test",
      secret: "sealedSecret1",
    });
    expect(sealed().hasSecret()).toBe(true);
  });

  it("never writes the secret into settings.json when the vault seals it", () => {
    sealed().setHubConfig({ hmacSecret: "NEVER_PLAINTEXT_7a7a" });
    const raw = readFileSync(join(dir, "settings.json"), "utf8");
    expect(raw).not.toContain("NEVER_PLAINTEXT_7a7a");
  });

  it("securityStatus reports sealed mode + a fingerprint once a secret is sealed", () => {
    const s = sealed();
    s.setHubConfig({ hmacSecret: "s1" });
    const st = s.securityStatus();
    expect(st.mode).toBe("sealed");
    expect(st.plaintextFallback).toBe(false);
    expect(st.sealedCount).toBe(1);
    expect(st.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("SettingsStore — plaintext fallback (no master key)", () => {
  it("with a keyless vault, behaves like today's plaintext path", () => {
    // Vault present but no master key → cannot seal → plaintext fallback.
    const keyless = () =>
      new SettingsStore({ filePath: join(dir, "settings.json"), vault: openVault(undefined) });
    const s = keyless();
    s.setHubConfig({ hubBaseUrl: "https://hub.test", hmacSecret: "devSecret" });
    expect(keyless().hubConfig()).toEqual({
      baseUrl: "https://hub.test",
      secret: "devSecret",
    });
    expect(s.securityStatus().plaintextFallback).toBe(true);
    expect(s.securityStatus().mode).toBe("empty");
  });

  it("securityStatus with no vault at all is plaintext-fallback/empty", () => {
    const st = fresh().securityStatus();
    expect(st).toMatchObject({ mode: "empty", plaintextFallback: true, sealedCount: 0 });
  });

  it("a wrong master key (locked) disables the feed rather than leaking/crashing", () => {
    // Seal under the real key, then re-open with a DIFFERENT key (rotated env).
    sealed(VKEY).setHubConfig({ hubBaseUrl: "https://hub.test", hmacSecret: "sealedSecret" });
    const wrong = new SettingsStore({
      filePath: join(dir, "settings.json"),
      vault: openVault(VKEY2), // a different valid key
    });
    expect(wrong.hubConfig()).toBeNull(); // feed falls back to env/off, not a stale secret
    expect(wrong.hasSecret()).toBe(false);
    expect(wrong.securityStatus().mode).toBe("locked");
  });
});

describe("SettingsStore report toggle", () => {
  it("defaults to ON (report enabled)", () => {
    expect(fresh().reportEnabled()).toBe(true);
  });

  it("turns off and on, persisting across reloads", () => {
    fresh().setReportEnabled(false);
    expect(fresh().reportEnabled()).toBe(false);
    fresh().setReportEnabled(true);
    expect(fresh().reportEnabled()).toBe(true);
  });
});
