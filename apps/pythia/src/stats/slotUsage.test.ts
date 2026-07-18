import { describe, it, expect } from "vitest";
import { SlotUsageMeter } from "./slotUsage.js";

describe("SlotUsageMeter", () => {
  it("records keyed vs anon + ok + keyedPondus per slot", () => {
    const m = new SlotUsageMeter({ clock: () => new Date("2026-07-05T00:00:00.000Z") });
    // s1's operator is "k:abc" (a slot property from the feed — passed the same
    // for every read on s1, keyed or anon); s2 is a usable-but-unearning slot.
    m.record("s1", "k:abc", true, true, 12.5);
    m.record("s1", "k:abc", true, true, 7.5);
    m.record("s1", "k:abc", false, true, 0); // anonymous read on s1
    m.record("s2", null, false, false, 0); // anonymous, not ok

    const w = m.drain();
    const s1 = w.slots.find((s) => s.id === "s1");
    expect(s1).toMatchObject({
      operator: "k:abc",
      keyedRequests: 2,
      anonRequests: 1,
      ok: 3,
      keyedPondus: 20,
    });
    const s2 = w.slots.find((s) => s.id === "s2");
    expect(s2).toMatchObject({ keyedRequests: 0, anonRequests: 1, ok: 0 });
  });

  it("keyedPondus never counts anonymous requests", () => {
    const m = new SlotUsageMeter({ clock: () => new Date("2026-07-05T00:00:00.000Z") });
    m.record("s1", null, false, true, 99); // anon — pondus ignored
    expect(m.drain().slots[0].keyedPondus).toBe(0);
  });

  it("drain resets into a contiguous, non-overlapping window", () => {
    let t = "2026-07-05T00:00:00.000Z";
    const m = new SlotUsageMeter({ clock: () => new Date(t) });
    m.record("s1", null, true, true, 5);
    t = "2026-07-05T00:01:00.000Z";
    const w1 = m.drain();
    expect(w1.period).toEqual({ from: "2026-07-05T00:00:00.000Z", to: "2026-07-05T00:01:00.000Z" });
    expect(m.isEmpty()).toBe(true);

    t = "2026-07-05T00:02:00.000Z";
    const w2 = m.drain();
    // the next window STARTS where the last ended — no gap, no overlap
    expect(w2.period).toEqual({ from: "2026-07-05T00:01:00.000Z", to: "2026-07-05T00:02:00.000Z" });
    expect(w2.slots).toEqual([]);
  });

  it("rounds keyedPondus to <=3 dp", () => {
    const m = new SlotUsageMeter({ clock: () => new Date("2026-07-05T00:00:00.000Z") });
    m.record("s1", null, true, true, 0.0001);
    m.record("s1", null, true, true, 0.0001);
    expect(m.drain().slots[0].keyedPondus).toBe(0);
  });
});
