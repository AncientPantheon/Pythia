import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorStore } from "./store.js";

let dir: string;
function freshStore(): ConnectorStore {
  return new ConnectorStore({ filePath: join(dir, "connectors.json") });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pythia-conn-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ConnectorStore", () => {
  it("mints a shown-once key and never stores it in retrievable form", () => {
    const store = freshStore();
    const { view, apiKey } = store.add({ name: "OuronetUI", url: "https://ouro.example", isPublic: true });

    expect(apiKey).toMatch(/^pk_live_[A-Za-z0-9_-]+$/);
    expect(view.name).toBe("OuronetUI");
    expect(view.keyPrefix).toBe(apiKey.slice(0, 12));
    // The admin view must never carry the hash or the raw key.
    expect(JSON.stringify(view)).not.toContain(apiKey);
    expect(view).not.toHaveProperty("keyHash");
  });

  it("attributes a raw key back to its connector name, and only the exact key", () => {
    const store = freshStore();
    const { apiKey } = store.add({ name: "Aletheia", url: "https://a.example", isPublic: false });

    expect(store.nameForKey(apiKey)).toBe("Aletheia");
    expect(store.nameForKey("pk_live_wrong")).toBeUndefined();
  });

  it("exposes only public connectors on the public list", () => {
    const store = freshStore();
    store.add({ name: "Public", url: "https://p.example", isPublic: true, logo: "/l.png" });
    store.add({ name: "Private", url: "https://x.example", isPublic: false });

    const pub = store.publicList();
    expect(pub).toEqual([{ name: "Public", url: "https://p.example", logo: "/l.png" }]);
  });

  it("revokes by id — the key stops attributing and it leaves the list", () => {
    const store = freshStore();
    const { view, apiKey } = store.add({ name: "Temp", url: "https://t.example", isPublic: false });

    expect(store.revoke(view.id)).toBe(true);
    expect(store.nameForKey(apiKey)).toBeUndefined();
    expect(store.list()).toHaveLength(0);
    expect(store.revoke(view.id)).toBe(false); // idempotent
  });

  it("persists across reloads (survives a restart)", () => {
    const first = freshStore();
    const { apiKey } = first.add({ name: "Persisted", url: "https://p.example", isPublic: true });

    const reloaded = freshStore();
    expect(reloaded.nameForKey(apiKey)).toBe("Persisted");
    expect(reloaded.publicList()).toHaveLength(1);
  });
});
