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
  it("bakes in the seed nodes (present + tagged) so sends/reads work from deployment", () => {
    const s = new TxSenderStore({
      filePath: path(),
      seeds: [
        { url: "https://a", label: "node-a" },
        { url: "https://b", label: "node-b" },
      ],
    });
    const list = s.list();
    expect(list.map((x) => x.url)).toEqual(["https://a", "https://b"]);
    expect(list.every((x) => x.seed)).toBe(true);
    expect(s.enabledNodes().map((n) => n.url)).toEqual(["https://a", "https://b"]);
  });

  it("reconciles seeds on EVERY boot — tags a pre-existing plain node as a seed", () => {
    new TxSenderStore({ filePath: path() }).add({ url: "https://a", label: "was-plain" });
    const reloaded = new TxSenderStore({
      filePath: path(),
      seeds: [{ url: "https://a", label: "seed-a" }],
    });
    expect(reloaded.list().find((x) => x.url === "https://a")?.seed).toBe(true);
  });

  it("lets the admin add + remove their OWN nodes, but NOT seed nodes", () => {
    const s = new TxSenderStore({ filePath: path(), seeds: [{ url: "https://seed", label: "seed" }] });
    const added = s.add({ url: "https://added", label: "mine" });
    const seed = s.list().find((x) => x.seed)!;

    expect(s.remove(added.id)).toBe("removed");
    expect(s.remove(seed.id)).toBe("protected"); // seed is permanent
    expect(s.remove("nope")).toBe("not-found");
    expect(s.list().some((x) => x.seed)).toBe(true); // seed survives
  });

  it("enable/disable works on admin nodes; seed nodes are permanently enabled", () => {
    const s = new TxSenderStore({ filePath: path(), seeds: [{ url: "https://seed", label: "seed" }] });
    const seed = s.list().find((x) => x.seed)!;
    const added = s.add({ url: "https://added", label: "mine" });

    // A seed can never be switched off — it keeps the baseline serving guarantee.
    expect(s.setEnabled(seed.id, false)).toBe("protected");
    expect(s.list().find((x) => x.seed)!.enabled).toBe(true);

    // Admin nodes toggle freely and drop out of the dial when disabled.
    expect(s.setEnabled(added.id, false)).toBe("updated");
    expect(s.enabledNodes().map((n) => n.url)).toEqual(["https://seed"]);
    expect(s.setEnabled(added.id, true)).toBe("updated");
    expect(s.enabledNodes().map((n) => n.url).sort()).toEqual(["https://added", "https://seed"]);

    expect(s.setEnabled("nope", false)).toBe("not-found");
  });

  it("persists admin nodes + seeds across reload", () => {
    const s = new TxSenderStore({ filePath: path(), seeds: [{ url: "https://seed", label: "seed" }] });
    s.add({ url: "https://added", label: "mine" });
    const reloaded = new TxSenderStore({ filePath: path(), seeds: [{ url: "https://seed", label: "seed" }] });
    expect(reloaded.list().map((x) => x.url).sort()).toEqual(["https://added", "https://seed"]);
  });
});
