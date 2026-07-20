import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptySnapshot } from "@ancientpantheon/codex/ouronet";
import { ensureSodiumReady, parseMasterKey } from "../../codex/vault.js";
import { SealedStore } from "../../codex/sealedStore.js";
import { CodexStore } from "../codexStore.js";
import { getKhronotonDb, khronotonDir } from "./db.js";
import { createPythiaKeyResolver } from "./keyResolver.js";
import { buildKhronotonConfig } from "./context.js";

const KEY = Buffer.from(new Uint8Array(32).fill(8)).toString("base64");
type Glob = { __pythiaKhronotonDb?: { close?: () => void } };
let dir: string;

beforeAll(async () => {
  await ensureSodiumReady();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pythia-khronoton-"));
  process.env.PYTHIA_KHRONOTON_DIR = join(dir, "kh");
  (globalThis as Glob).__pythiaKhronotonDb = undefined;
});
afterEach(() => {
  (globalThis as Glob).__pythiaKhronotonDb?.close?.(); // release the sqlite handle before rm
  (globalThis as Glob).__pythiaKhronotonDb = undefined;
  delete process.env.PYTHIA_KHRONOTON_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function codexWith(backup: string | null): CodexStore {
  const c = new CodexStore(new SealedStore({ dir: join(dir, "vault"), keyProvider: () => parseMasterKey(KEY) }));
  if (backup) c.saveBackup(backup);
  return c;
}

describe("khronoton db", () => {
  it("opens the SQLite database + installs the engine schema (idempotent singleton)", () => {
    const db = getKhronotonDb();
    expect(db).toBeTruthy();
    expect(existsSync(join(khronotonDir(), "khronoton.db"))).toBe(true);
    expect(getKhronotonDb()).toBe(db); // same handle on the second call
  });
});

describe("khronoton config", () => {
  it("builds the full 6-field config with sane defaults", () => {
    const c = buildKhronotonConfig();
    expect(c.tickIntervalMs).toBeGreaterThan(0);
    expect(c.autoGasCeiling).toBeGreaterThan(0);
    expect(c.tickBatchLimit).toBeGreaterThan(0);
    expect(c.manualBatch.min).toBeLessThanOrEqual(c.manualBatch.max);
  });
});

describe("pythia key resolver (codex-backed signing seam)", () => {
  it("throws a clear error when the codex is uninitialized", async () => {
    const r = createPythiaKeyResolver(codexWith(null));
    await expect(r.listCodexPubs()).rejects.toThrow(/not initialized/);
  });

  it("an empty codex holds no pubs, and an unknown key is refused (never signs the wrong key)", async () => {
    const r = createPythiaKeyResolver(codexWith(JSON.stringify(emptySnapshot("main"))));
    expect((await r.listCodexPubs()).size).toBe(0);
    await expect(r.getKeyPairByPublicKey("deadbeefdeadbeef")).rejects.toThrow(/not held/);
  });
});
