import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TxSenderStore } from "./store.js";

let dir: string;
const path = () => join(dir, "tx.json");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pythia-tx-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("TxSenderStore (Upload Pool)", () => {
  it("seeds defaults on first run so sends work before curation", () => {
    const s = new TxSenderStore({
      filePath: path(),
      defaults: [
        { url: "https://a", label: "a" },
        { url: "https://b", label: "b" },
      ],
    });
    expect(s.enabledNodes().map((n) => n.url)).toEqual(["https://a", "https://b"]);
  });

  it("does NOT re-seed once populated", () => {
    new TxSenderStore({ filePath: path(), defaults: [{ url: "https://a", label: "a" }] });
    const reloaded = new TxSenderStore({
      filePath: path(),
      defaults: [{ url: "https://x", label: "x" }],
    });
    expect(reloaded.enabledNodes().map((n) => n.url)).toEqual(["https://a"]);
  });

  it("tries enabled senders in ADD order; disabled ones drop out", () => {
    const s = new TxSenderStore({ filePath: path() });
    const a = s.add({ url: "https://a", label: "a" });
    s.add({ url: "https://b", label: "b" });
    expect(s.enabledNodes().map((n) => n.url)).toEqual(["https://a", "https://b"]);
    s.setEnabled(a.id, false);
    expect(s.enabledNodes().map((n) => n.url)).toEqual(["https://b"]);
  });

  it("removes by id (idempotent), and an empty pool yields no nodes (→ 503 on send)", () => {
    const s = new TxSenderStore({ filePath: path() });
    const a = s.add({ url: "https://a", label: "a" });
    expect(s.remove(a.id)).toBe(true);
    expect(s.remove(a.id)).toBe(false);
    expect(s.enabledNodes()).toEqual([]);
  });

  it("persists across reload", () => {
    new TxSenderStore({ filePath: path() }).add({ url: "https://a", label: "keep" });
    const reloaded = new TxSenderStore({ filePath: path() });
    expect(reloaded.list().map((s) => s.url)).toEqual(["https://a"]);
  });
});
