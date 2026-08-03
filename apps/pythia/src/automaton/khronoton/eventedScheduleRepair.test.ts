import { describe, it, expect } from "vitest";
import { repairEventedScheduleless, type RepairDb } from "./eventedScheduleRepair.js";

/** A fake db that records each prepare(sql).run(...params) and returns `changes`. */
function fakeDb(changesPerRun: number): { db: RepairDb; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db: RepairDb = {
    prepare(sql: string) {
      return {
        run(...params: unknown[]) {
          calls.push({ sql, params });
          return { changes: changesPerRun };
        },
      };
    },
  };
  return { db, calls };
}

describe("repairEventedScheduleless", () => {
  it("forces each evented resolver's still-scheduled row to scheduleless", () => {
    const { db, calls } = fakeDb(1);
    const fixed = repairEventedScheduleless(db, ["dual-link-activate"]);
    expect(fixed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("UPDATE codex_cronotons");
    expect(calls[0].sql).toContain("external_fireable = 1");
    expect(calls[0].sql).toContain("next_fire_at = NULL");
    // Only touches rows that are still scheduled (idempotent on re-run).
    expect(calls[0].sql).toContain("external_fireable != 1 OR next_fire_at IS NOT NULL");
    expect(calls[0].params).toEqual(["dual-link-activate"]);
  });

  it("is a no-op count when nothing is stale (idempotent second run)", () => {
    const { db } = fakeDb(0);
    expect(repairEventedScheduleless(db, ["dual-link-activate"])).toBe(0);
  });

  it("processes every evented name and sums the rows fixed", () => {
    const { db, calls } = fakeDb(1);
    const fixed = repairEventedScheduleless(db, ["a", "b", "c"]);
    expect(fixed).toBe(3);
    expect(calls.map((c) => c.params[0])).toEqual(["a", "b", "c"]);
  });

  it("a db error is guarded (logged, non-fatal) and never throws or blocks boot", () => {
    const db: RepairDb = {
      prepare() {
        return {
          run() {
            throw new Error("schema drift");
          },
        };
      },
    };
    expect(() => repairEventedScheduleless(db, ["dual-link-activate"])).not.toThrow();
    expect(repairEventedScheduleless(db, ["dual-link-activate"])).toBe(0);
  });
});
