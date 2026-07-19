import { describe, it, expect } from "vitest";
import { emptySnapshot } from "@ancientpantheon/codex/ouronet";
import { rekeyBackupBlob, NotASnapshotError } from "./codexRekey.js";

describe("rekeyBackupBlob", () => {
  it("re-keys an empty codex snapshot and returns a valid snapshot blob", async () => {
    const blob = JSON.stringify(emptySnapshot("main"));
    const { blob: out } = await rekeyBackupBlob(blob, "old-pass", "new-pass");
    const parsed = JSON.parse(out);
    expect(typeof parsed.schemaVersion).toBe("number");
    expect(Array.isArray(parsed.kadenaSeeds)).toBe(true);
  });

  it("rejects a wallet-export envelope (not a raw snapshot)", async () => {
    const walletBlob = JSON.stringify({ kadenaWallets: [], ouronetWallets: [] });
    await expect(rekeyBackupBlob(walletBlob, "a", "b")).rejects.toBeInstanceOf(NotASnapshotError);
  });

  it("rejects a blob missing snapshot fields", async () => {
    await expect(rekeyBackupBlob(JSON.stringify({ foo: 1 }), "a", "b")).rejects.toBeInstanceOf(
      NotASnapshotError,
    );
  });

  it("throws on malformed JSON", async () => {
    await expect(rekeyBackupBlob("<not json>", "a", "b")).rejects.toThrow();
  });
});
