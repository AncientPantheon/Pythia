import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { StatsStore } from "./store.js";
import { statsMiddleware } from "./middleware.js";

function scratchStore(): { store: StatsStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pythia-mw-"));
  const store = new StatsStore({
    filePath: join(dir, "stats.json"),
    flushMs: 0,
    clock: () => new Date("2026-07-05T12:00:00.000Z"),
  });
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A Hono app that mounts the middleware then answers read/send/poll + others. */
function appWith(store: StatsStore, consumerMap: Map<string, string>): Hono {
  const app = new Hono();
  app.use("*", statsMiddleware(store, consumerMap));
  app.post("/stoachain/read", (c) => c.json({ ok: true }));
  app.post("/stoachain/send", (c) => c.json({ ok: true }, 400));
  app.post("/stoachain/poll", (c) => c.json({ ok: true }));
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/", (c) => c.text("landing"));
  return app;
}

describe("statsMiddleware", () => {
  it("records a read with the chain, endpoint, and mapped consumer", async () => {
    // A /stoachain/read carrying a registered key is attributed to that consumer,
    // on the stoachain chain, as a read — the core attribution unit.
    const { store, cleanup } = scratchStore();
    const app = appWith(store, new Map([["k1", "OuronetUI"]]));

    await app.request("/stoachain/read", {
      method: "POST",
      headers: { "x-pythia-key": "k1" },
    });

    const v = store.views();
    expect(v.totals.read).toBe(1);
    expect(v.byChain).toEqual({ stoachain: 1 });
    expect(v.byConsumer).toEqual({ OuronetUI: 1 });
    cleanup();
  });

  it("attributes a keyless request to 'direct'", async () => {
    // Traffic with no x-pythia-key header is anonymous and buckets as "direct".
    const { store, cleanup } = scratchStore();
    const app = appWith(store, new Map([["k1", "OuronetUI"]]));

    await app.request("/stoachain/poll", { method: "POST" });

    expect(store.views().byConsumer).toEqual({ direct: 1 });
    expect(store.views().totals.poll).toBe(1);
    cleanup();
  });

  it("marks ok=false (an error) when the handler responds >= 400", async () => {
    // The /send handler above returns 400; the middleware records it as an error
    // so totals.errors reflects real failures, not just request volume.
    const { store, cleanup } = scratchStore();
    const app = appWith(store, new Map());

    await app.request("/stoachain/send", { method: "POST" });

    const v = store.views();
    expect(v.totals.send).toBe(1);
    expect(v.totals.errors).toBe(1);
    cleanup();
  });

  it("does NOT record health, static, or unknown paths", async () => {
    // Health is polled every 15s and would swamp real usage; only the three
    // operational verbs are counted, so /healthz and / record nothing.
    const { store, cleanup } = scratchStore();
    const app = appWith(store, new Map());

    await app.request("/healthz");
    await app.request("/");

    expect(store.views().totals.requests).toBe(0);
    cleanup();
  });

  it("buckets the request under the store's UTC day", async () => {
    // Day attribution comes from the store clock (frozen to 2026-07-05) so the
    // recorded bucket lands on that day regardless of the host wall clock.
    const { store, cleanup } = scratchStore();
    const app = appWith(store, new Map());

    await app.request("/stoachain/read", { method: "POST" });

    expect(store.views().since).toBe("2026-07-05");
    expect(store.views().daily.at(-1)).toMatchObject({ day: "2026-07-05", read: 1 });
    cleanup();
  });
});
