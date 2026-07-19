import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSodiumReady, parseMasterKey } from "../codex/vault.js";
import { SealedStore } from "../codex/sealedStore.js";
import { CodexStore } from "./codexStore.js";

const KEY = Buffer.from(new Uint8Array(32).fill(5)).toString("base64");
let dir: string;
const codex = () =>
  new CodexStore(new SealedStore({ dir, keyProvider: () => parseMasterKey(KEY) }));

beforeAll(async () => {
  await ensureSodiumReady();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pythia-codex-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("CodexStore", () => {
  it("mints a 32-byte-base64 machine password, sealed + idempotent across reloads", () => {
    const pw = codex().getOrCreateCodexPassword();
    expect(Buffer.from(pw, "base64")).toHaveLength(32);
    // A fresh store over the same vault returns the SAME password (not a new one).
    expect(codex().getOrCreateCodexPassword()).toBe(pw);
  });

  it("round-trips the sealed backup blob and provisions the password on save", () => {
    codex().saveBackup('{"schemaVersion":1,"kadenaSeeds":[]}');
    expect(codex().loadBackup()).toBe('{"schemaVersion":1,"kadenaSeeds":[]}');
    expect(codex().getOrCreateCodexPassword()).toBeTruthy(); // provisioned by saveBackup
    expect(codex().initialized()).toBe(true);
  });

  it("is uninitialized with a null backup until first save", () => {
    expect(codex().initialized()).toBe(false);
    expect(codex().loadBackup()).toBeNull();
  });

  it("clearCodex removes both the backup and the password", () => {
    const c = codex();
    c.saveBackup("blob");
    c.clearCodex();
    expect(codex().initialized()).toBe(false);
    expect(codex().loadBackup()).toBeNull();
  });
});
