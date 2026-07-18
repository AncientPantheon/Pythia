import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PythLedger } from "./ledger.js";

const tmpDirs: string[] = [];
function scratchFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "pyth-ledger-"));
  tmpDirs.push(dir);
  return join(dir, "ledger.json");
}
function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function make(clock = fixedClock("2026-07-05T10:00:00.000Z"), filePath = scratchFile()) {
  return new PythLedger({ filePath, flushMs: 0, clock });
}

describe("PythLedger", () => {
  it("records reads as petitions + summed pondus", () => {
    const l = make();
    l.recordRead(10);
    l.recordRead(363.553);
    const t = l.total();
    expect(t.petitions).toBe(2);
    expect(t.pondus).toBe(373.553);
  });

  it("splits accepted vs rejected sends into tx/gas vs failed/wasted", () => {
    const l = make();
    l.recordSend(true, 1500);
    l.recordSend(true, 500);
    l.recordSend(false, 800);
    const t = l.total();
    expect(t.transactions).toBe(2);
    expect(t.gasReserved).toBe(2000);
    expect(t.failedTransactions).toBe(1);
    expect(t.wastedGasReserved).toBe(800);
  });

  it("aggregates across days; total = sum of the daily deltas", () => {
    let iso = "2026-07-05T10:00:00.000Z";
    const l = new PythLedger({ filePath: scratchFile(), flushMs: 0, clock: () => new Date(iso) });
    l.recordRead(10); // day 05
    iso = "2026-07-06T10:00:00.000Z";
    l.recordRead(20); // day 06
    l.recordSend(true, 500); // day 06

    const daily = l.daily();
    expect(daily.map((d) => d.day)).toEqual(["2026-07-05", "2026-07-06"]);
    expect(daily[0].petitions).toBe(1);
    expect(daily[1].petitions).toBe(1);
    expect(daily[1].transactions).toBe(1);

    const t = l.total();
    expect(t.petitions).toBe(2);
    expect(t.pondus).toBe(30);
    expect(t.gasReserved).toBe(500);
  });

  it("nuke resets everything to zero", () => {
    const l = make();
    l.recordRead(10);
    l.recordSend(true, 100);
    l.nuke();
    const t = l.total();
    expect(t.petitions).toBe(0);
    expect(t.transactions).toBe(0);
    expect(t.gasReserved).toBe(0);
    expect(l.daily()).toHaveLength(0);
  });

  it("persists and reloads across instances", () => {
    const file = scratchFile();
    const a = new PythLedger({ filePath: file, flushMs: 0, clock: fixedClock("2026-07-05T10:00:00.000Z") });
    a.recordRead(42);
    a.recordSend(true, 999);
    a.persist();

    const b = new PythLedger({ filePath: file, flushMs: 0, clock: fixedClock("2026-07-05T10:00:00.000Z") });
    const t = b.total();
    expect(t.petitions).toBe(1);
    expect(t.pondus).toBe(42);
    expect(t.gasReserved).toBe(999);
  });

  it("rounds the pondus total to <=3 decimals", () => {
    const l = make();
    l.recordRead(0.0001);
    l.recordRead(0.0001);
    expect(l.total().pondus).toBe(0); // 0.0002 → 0.000
  });
});
