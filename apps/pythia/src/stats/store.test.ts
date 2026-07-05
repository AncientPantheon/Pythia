import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatsStore } from "./store.js";

const tmpDirs: string[] = [];
function scratchFile(name = "stats.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "pythia-stats-"));
  tmpDirs.push(dir);
  return join(dir, name);
}

/** A clock frozen to a given UTC instant, for deterministic day bucketing. */
function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore(overrides: Partial<ConstructorParameters<typeof StatsStore>[0]> = {}) {
  return new StatsStore({
    filePath: scratchFile(),
    flushMs: 0, // 0 disables the timer for deterministic tests
    clock: fixedClock("2026-07-05T10:00:00.000Z"),
    ...overrides,
  });
}

describe("StatsStore.record + views", () => {
  it("aggregates counts per day/consumer/chain/endpoint/ok into totals", () => {
    // Each operational request increments exactly one bucket; totals.requests is
    // the sum across all verbs, and per-verb totals split by endpoint.
    const store = makeStore();
    store.record({ consumer: "OuronetUI", chain: "stoachain", endpoint: "read", ok: true, day: "2026-07-05" });
    store.record({ consumer: "OuronetUI", chain: "stoachain", endpoint: "read", ok: true, day: "2026-07-05" });
    store.record({ consumer: "direct", chain: "stoachain", endpoint: "send", ok: true, day: "2026-07-05" });
    store.record({ consumer: "direct", chain: "stoachain", endpoint: "poll", ok: false, day: "2026-07-05" });

    const v = store.views();
    expect(v.totals.requests).toBe(4);
    expect(v.totals.read).toBe(2);
    expect(v.totals.send).toBe(1);
    expect(v.totals.poll).toBe(1);
    expect(v.totals.errors).toBe(1);
  });

  it("splits totals by chain and by consumer", () => {
    // byChain and byConsumer let the operator see which chain and which named
    // caller drive traffic — the core attribution the analytics exist for.
    const store = makeStore();
    store.record({ consumer: "OuronetUI", chain: "stoachain", endpoint: "read", ok: true, day: "2026-07-05" });
    store.record({ consumer: "OuronetUI", chain: "stoachain", endpoint: "read", ok: true, day: "2026-07-05" });
    store.record({ consumer: "direct", chain: "stoachain", endpoint: "send", ok: true, day: "2026-07-05" });

    const v = store.views();
    expect(v.byChain).toEqual({ stoachain: 3 });
    expect(v.byConsumer).toEqual({ OuronetUI: 2, direct: 1 });
  });

  it("sets `since` to the first recorded day", () => {
    // The `since` marker is the earliest day the store has data for — it anchors
    // the daily series and reads null before any request.
    const store = makeStore();
    expect(store.views().since).toBeNull();

    store.record({ consumer: "direct", chain: "stoachain", endpoint: "read", ok: true, day: "2026-07-04" });
    store.record({ consumer: "direct", chain: "stoachain", endpoint: "read", ok: true, day: "2026-07-05" });

    expect(store.views().since).toBe("2026-07-04");
  });

  it("fills daily gaps with zero-count days between since and today (ascending)", () => {
    // The graph needs a continuous daily series; a day with no traffic must still
    // appear with zero requests so the chart shows the gap, not a compressed axis.
    const store = new StatsStore({
      filePath: scratchFile(),
      flushMs: 0,
      clock: fixedClock("2026-07-05T10:00:00.000Z"),
    });
    store.record({ consumer: "direct", chain: "stoachain", endpoint: "read", ok: true, day: "2026-07-03" });
    store.record({ consumer: "direct", chain: "stoachain", endpoint: "send", ok: true, day: "2026-07-05" });

    const daily = store.views().daily;
    expect(daily.map((d) => d.day)).toEqual(["2026-07-03", "2026-07-04", "2026-07-05"]);
    expect(daily[0]).toMatchObject({ day: "2026-07-03", requests: 1, read: 1, send: 0 });
    expect(daily[1]).toMatchObject({ day: "2026-07-04", requests: 0, read: 0 });
    expect(daily[2]).toMatchObject({ day: "2026-07-05", requests: 1, send: 1 });
  });

  it("today() returns the UTC day from the injected clock", () => {
    // The middleware asks the store for "today" so day bucketing is driven by one
    // injectable clock — the same clock the tests freeze.
    const store = makeStore({ clock: fixedClock("2026-12-31T23:59:59.000Z") });
    expect(store.today()).toBe("2026-12-31");
  });
});

describe("StatsStore snapshot/fromSnapshot", () => {
  it("round-trips the counter map and since marker", () => {
    // Persistence relies on snapshot→fromSnapshot being loss-free so a restart
    // restores the exact aggregates and the original since anchor.
    const store = makeStore();
    store.record({ consumer: "OuronetUI", chain: "stoachain", endpoint: "read", ok: true, day: "2026-07-04" });
    store.record({ consumer: "direct", chain: "stoachain", endpoint: "poll", ok: false, day: "2026-07-05" });

    const restored = StatsStore.fromSnapshot(store.snapshot(), {
      filePath: scratchFile(),
      flushMs: 0,
      clock: fixedClock("2026-07-05T10:00:00.000Z"),
    });

    expect(restored.views().totals).toEqual(store.views().totals);
    expect(restored.views().byConsumer).toEqual(store.views().byConsumer);
    expect(restored.views().since).toBe("2026-07-04");
  });
});

describe("StatsStore persistence", () => {
  it("flush writes an atomic snapshot that a fresh store loads on construct", () => {
    // Graceful shutdown flushes to disk; the next boot must reconstruct the exact
    // aggregates from that file — the durable half of the in-memory store.
    const file = scratchFile();
    const store = new StatsStore({ filePath: file, flushMs: 0, clock: fixedClock("2026-07-05T10:00:00.000Z") });
    store.record({ consumer: "Aletheia", chain: "stoachain", endpoint: "read", ok: true, day: "2026-07-05" });
    store.flush();

    expect(existsSync(file)).toBe(true);
    // Atomic write leaves no stray .tmp behind after a successful rename.
    expect(existsSync(`${file}.tmp`)).toBe(false);

    const reloaded = new StatsStore({ filePath: file, flushMs: 0, clock: fixedClock("2026-07-05T10:00:00.000Z") });
    expect(reloaded.views().totals.requests).toBe(1);
    expect(reloaded.views().byConsumer).toEqual({ Aletheia: 1 });
  });

  it("loads an empty store when the file is missing (no throw)", () => {
    // A first boot has no snapshot file; the store must start empty rather than
    // fail to construct.
    const store = new StatsStore({ filePath: scratchFile("absent.json"), flushMs: 0, clock: fixedClock("2026-07-05T10:00:00.000Z") });
    expect(store.views().totals.requests).toBe(0);
    expect(store.views().since).toBeNull();
  });

  it("loads an empty store + warns when the file is corrupt (no throw)", () => {
    // A truncated/garbled snapshot must not crash the boot; it warns and starts
    // empty so the service keeps serving.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const file = scratchFile();
    writeFileSync(file, "{ this is not json");

    const store = new StatsStore({ filePath: file, flushMs: 0, clock: fixedClock("2026-07-05T10:00:00.000Z") });

    expect(store.views().totals.requests).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it("creates the parent directory when it does not exist", () => {
    // The default STATS_FILE may point into a dir the container has not made yet;
    // flush must mkdir -p rather than throw ENOENT.
    const dir = mkdtempSync(join(tmpdir(), "pythia-stats-"));
    tmpDirs.push(dir);
    const file = join(dir, "nested", "deep", "stats.json");
    const store = new StatsStore({ filePath: file, flushMs: 0, clock: fixedClock("2026-07-05T10:00:00.000Z") });
    store.record({ consumer: "direct", chain: "stoachain", endpoint: "read", ok: true, day: "2026-07-05" });
    store.flush();

    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toBeTruthy();
  });
});

describe("StatsStore.pruneBefore", () => {
  it("drops buckets strictly before the given day", () => {
    // Retention helper: pruning before a cutoff removes older daily buckets while
    // keeping the cutoff day and everything after it.
    const store = makeStore();
    store.record({ consumer: "direct", chain: "stoachain", endpoint: "read", ok: true, day: "2026-07-01" });
    store.record({ consumer: "direct", chain: "stoachain", endpoint: "read", ok: true, day: "2026-07-05" });

    store.pruneBefore("2026-07-05");

    const daily = store.views().daily;
    expect(daily.some((d) => d.day === "2026-07-01" && d.requests > 0)).toBe(false);
    expect(store.views().totals.requests).toBe(1);
  });
});
