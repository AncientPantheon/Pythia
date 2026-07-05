import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { StatsStore } from "../stats/store.js";
import { registerStats } from "./stats.js";

function seededStore(): { store: StatsStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pythia-stats-route-"));
  const store = new StatsStore({
    filePath: join(dir, "stats.json"),
    flushMs: 0,
    clock: () => new Date("2026-07-05T12:00:00.000Z"),
  });
  store.record({ consumer: "OuronetUI", chain: "stoachain", endpoint: "read", ok: true, day: "2026-07-04" });
  store.record({ consumer: "OuronetUI", chain: "stoachain", endpoint: "read", ok: true, day: "2026-07-05" });
  store.record({ consumer: "direct", chain: "stoachain", endpoint: "send", ok: false, day: "2026-07-05" });
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function appWith(store: StatsStore): Hono {
  const app = new Hono();
  registerStats(app, store);
  return app;
}

describe("GET /stats", () => {
  it("returns the store's aggregate totals as JSON", async () => {
    // The endpoint is the public read of the analytics store — its totals must
    // equal what the store recorded (3 requests, 2 reads, 1 send, 1 error).
    const { store, cleanup } = seededStore();

    const res = await appWith(store).request("/stats");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: { requests: number; read: number; send: number; poll: number; errors: number };
    };
    expect(body.totals).toEqual({ requests: 3, read: 2, send: 1, poll: 0, errors: 1 });
    cleanup();
  });

  it("exposes since, byChain, byConsumer, and a gap-filled daily series", async () => {
    // The page renders attribution + a daily graph; the payload must carry the
    // since anchor, per-chain/consumer splits, and every day from since..today.
    const { store, cleanup } = seededStore();

    const body = (await (await appWith(store).request("/stats")).json()) as {
      since: string | null;
      byChain: Record<string, number>;
      byConsumer: Record<string, number>;
      daily: { day: string; requests: number }[];
    };

    expect(body.since).toBe("2026-07-04");
    expect(body.byChain).toEqual({ stoachain: 3 });
    expect(body.byConsumer).toEqual({ OuronetUI: 2, direct: 1 });
    expect(body.daily.map((d) => d.day)).toEqual(["2026-07-04", "2026-07-05"]);
    expect(body.daily[1].requests).toBe(2);
    cleanup();
  });

  it("returns a well-formed empty payload before any request", async () => {
    // A fresh deploy has no data; the endpoint must return since=null and zeroed
    // totals with an empty daily series rather than erroring.
    const dir = mkdtempSync(join(tmpdir(), "pythia-stats-empty-"));
    const store = new StatsStore({ filePath: join(dir, "s.json"), flushMs: 0, clock: () => new Date("2026-07-05T00:00:00.000Z") });

    const body = (await (await appWith(store).request("/stats")).json()) as {
      since: string | null;
      totals: { requests: number };
      daily: unknown[];
    };

    expect(body.since).toBeNull();
    expect(body.totals.requests).toBe(0);
    expect(body.daily).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
