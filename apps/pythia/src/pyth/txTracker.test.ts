import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PythLedger } from "./ledger.js";
import { TxTracker } from "./txTracker.js";

const tmpDirs: string[] = [];
function ledger(): PythLedger {
  const dir = mkdtempSync(join(tmpdir(), "pyth-tracker-"));
  tmpDirs.push(dir);
  return new PythLedger({
    filePath: join(dir, "l.json"),
    flushMs: 0,
    clock: () => new Date("2026-07-05T00:00:00.000Z"),
  });
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("TxTracker", () => {
  it("records a mined SUCCESS as a transaction with the ACTUAL gas", async () => {
    const l = ledger();
    const t = new TxTracker({
      ledger: l,
      poll: async () => new Map([["rk1", { success: true, gas: 731 }]]),
      clock: () => 1000,
    });
    t.track([{ requestKey: "rk1", gasLimit: 1500 }]);
    await t.tick();
    const total = l.total();
    expect(total.transactions).toBe(1);
    expect(total.gasReserved).toBe(731); // actual gas, not the 1500 limit
    expect(total.failedTransactions).toBe(0);
    expect(t.pendingCount()).toBe(0);
  });

  it("records a mined FAILURE as a failed transaction + actual wasted gas", async () => {
    const l = ledger();
    const t = new TxTracker({
      ledger: l,
      poll: async () => new Map([["rk1", { success: false, gas: 400 }]]),
      clock: () => 1000,
    });
    t.track([{ requestKey: "rk1", gasLimit: 1500 }]);
    await t.tick();
    const total = l.total();
    expect(total.failedTransactions).toBe(1);
    expect(total.wastedGasReserved).toBe(400);
    expect(total.transactions).toBe(0);
  });

  it("leaves an unmined tx pending (absent from the poll map)", async () => {
    const l = ledger();
    const t = new TxTracker({
      ledger: l,
      poll: async () => new Map(), // not mined yet
      clock: () => 1000,
      maxAgeMs: 60_000,
    });
    t.track([{ requestKey: "rk1", gasLimit: 1500 }]);
    await t.tick();
    expect(t.pendingCount()).toBe(1);
    expect(l.total().transactions).toBe(0);
    expect(l.total().failedTransactions).toBe(0);
  });

  it("times out an unmined tx (past maxAge) as failed + reserved gasLimit wasted", async () => {
    const l = ledger();
    let now = 1000;
    const t = new TxTracker({
      ledger: l,
      poll: async () => new Map(),
      clock: () => now,
      maxAgeMs: 5000,
    });
    t.track([{ requestKey: "rk1", gasLimit: 1500 }]);
    await t.tick(); // still pending
    expect(t.pendingCount()).toBe(1);
    now = 7000; // past the 5s maxAge
    await t.tick();
    const total = l.total();
    expect(total.failedTransactions).toBe(1);
    expect(total.wastedGasReserved).toBe(1500); // the reserved limit, since it never executed
    expect(t.pendingCount()).toBe(0);
  });

  it("survives a transient poll error and retries next tick", async () => {
    const l = ledger();
    let calls = 0;
    const t = new TxTracker({
      ledger: l,
      poll: async () => {
        calls += 1;
        if (calls === 1) throw new Error("network");
        return new Map([["rk1", { success: true, gas: 100 }]]);
      },
      clock: () => 1000,
    });
    t.track([{ requestKey: "rk1", gasLimit: 500 }]);
    await t.tick(); // throws internally, stays pending
    expect(t.pendingCount()).toBe(1);
    await t.tick(); // resolves
    expect(l.total().transactions).toBe(1);
    expect(t.pendingCount()).toBe(0);
  });

  it("dedupes a repeated requestKey", () => {
    const t = new TxTracker({ ledger: ledger(), poll: async () => new Map(), clock: () => 1 });
    t.track([{ requestKey: "rk1", gasLimit: 100 }]);
    t.track([{ requestKey: "rk1", gasLimit: 999 }]);
    expect(t.pendingCount()).toBe(1);
  });
});

describe("TxTracker — per-consumer attribution", () => {
  it("credits a mined tx's consumer in the per-consumer tally", async () => {
    const l = ledger();
    const t = new TxTracker({
      ledger: l,
      poll: async () => new Map([["rk1", { success: true, gas: 500 }]]),
      clock: () => 1000,
    });
    t.track([{ requestKey: "rk1", gasLimit: 1500, consumer: "ouronetui" }]);
    await t.tick();
    expect(l.byConsumer().ouronetui).toEqual({
      transactions: 1,
      failedTransactions: 0,
      gasReserved: 500,
      wastedGasReserved: 0, petitions: 0, pondus: 0
    });
  });

  it("credits a timed-out tx's consumer as a failed transaction", async () => {
    const l = ledger();
    let now = 1000;
    const t = new TxTracker({
      ledger: l,
      poll: async () => new Map(), // never mines
      clock: () => now,
      maxAgeMs: 5000,
    });
    t.track([{ requestKey: "rk1", gasLimit: 1500, consumer: "mnemosyne" }]);
    now = 7000; // past maxAge
    await t.tick();
    expect(l.byConsumer().mnemosyne).toEqual({
      transactions: 0,
      failedTransactions: 1,
      gasReserved: 0,
      wastedGasReserved: 1500, petitions: 0, pondus: 0
    });
  });

  it("a tracked tx with no consumer records the aggregate only (byConsumer empty)", async () => {
    const l = ledger();
    const t = new TxTracker({
      ledger: l,
      poll: async () => new Map([["rk1", { success: true, gas: 400 }]]),
      clock: () => 1000,
    });
    t.track([{ requestKey: "rk1", gasLimit: 1500 }]);
    await t.tick();
    expect(l.total().transactions).toBe(1);
    expect(l.byConsumer()).toEqual({});
  });
});
