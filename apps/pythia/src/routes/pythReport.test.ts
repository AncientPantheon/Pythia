import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { PythLedger } from "../pyth/ledger.js";
import { registerPythReport } from "./pythReport.js";
import { pondus, CLASS_BASE } from "../pyth/pondus.js";

const tmpDirs: string[] = [];
function ledger(): PythLedger {
  const dir = mkdtempSync(join(tmpdir(), "pyth-report-"));
  tmpDirs.push(dir);
  return new PythLedger({ filePath: join(dir, "l.json"), flushMs: 0, clock: () => new Date("2026-07-05T00:00:00.000Z") });
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// "HUBKEY" → the allow-listed reporter "dalos"; any other key → "acme"; none → "direct".
const resolveConsumer = (k?: string) => (k === "HUBKEY" ? "dalos" : k ? "acme" : "direct");

function appWith(l: PythLedger) {
  const app = new Hono();
  registerPythReport(app, { ledger: l, resolveConsumer, reporters: new Set(["dalos"]) });
  return app;
}
function post(app: Hono, body: unknown, key?: string) {
  return app.request("/pyth/report", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "x-pythia-key": key } : {}) },
    body: JSON.stringify(body),
  });
}

describe("POST /pyth/report", () => {
  it("records an allow-listed reporter's transactions AND reads into byConsumer + aggregate", async () => {
    const l = ledger();
    const app = appWith(l);
    const res = await post(
      app,
      {
        transactions: [{ gasLimit: 1000, accepted: true, count: 2 }, { gasLimit: 500, accepted: false }],
        reads: [{ gasUsed: 500000, responseBytes: 4096 }],
      },
      "HUBKEY",
    );
    expect(res.status).toBe(200);
    const c = l.byConsumer().dalos;
    expect(c.transactions).toBe(2);
    expect(c.gasReserved).toBe(2000);
    expect(c.failedTransactions).toBe(1);
    expect(c.wastedGasReserved).toBe(500);
    expect(c.petitions).toBe(1);
    // Pythia recomputes pondus from raw inputs — reporter never supplies it.
    expect(c.pondus).toBeCloseTo(pondus({ classBase: CLASS_BASE.read, gasUsed: 500000, responseBytes: 4096 }), 6);
    // aggregate moved too
    expect(l.total().transactions).toBe(2);
    expect(l.total().petitions).toBe(1);
  });

  it("expands a read entry's count into that many petitions", async () => {
    const l = ledger();
    await post(appWith(l), { reads: [{ gasUsed: 0, responseBytes: 0, count: 5 }] }, "HUBKEY");
    expect(l.byConsumer().dalos.petitions).toBe(5);
    expect(l.byConsumer().dalos.pondus).toBe(CLASS_BASE.read * 5); // 10 each, no gas/bytes
  });

  it("rejects a non-allow-listed keyed consumer with 403 (records nothing)", async () => {
    const l = ledger();
    const res = await post(appWith(l), { transactions: [{ gasLimit: 100, accepted: true }] }, "SOMEKEY");
    expect(res.status).toBe(403);
    expect(l.byConsumer()).toEqual({});
  });

  it("rejects an anonymous (unkeyed) report with 403", async () => {
    const l = ledger();
    const res = await post(appWith(l), { transactions: [{ gasLimit: 100, accepted: true }] });
    expect(res.status).toBe(403);
    expect(l.total().transactions).toBe(0);
  });

  it("rejects a malformed body / empty batch with 400", async () => {
    const l = ledger();
    const app = appWith(l);
    expect((await post(app, [], "HUBKEY")).status).toBe(400); // not an object
    expect((await post(app, {}, "HUBKEY")).status).toBe(400); // no entries
    expect((await post(app, { transactions: [], reads: [] }, "HUBKEY")).status).toBe(400);
  });

  it("rejects a bad numeric field WITHOUT recording anything (all-or-nothing)", async () => {
    const l = ledger();
    const app = appWith(l);
    const res = await post(
      app,
      { transactions: [{ gasLimit: 100, accepted: true }], reads: [{ gasUsed: -5, responseBytes: 10 }] },
      "HUBKEY",
    );
    expect(res.status).toBe(400);
    expect(l.byConsumer()).toEqual({}); // the valid tx was NOT recorded — batch rejected whole
  });

  it("rejects an over-count read entry (count > cap) with 400", async () => {
    const l = ledger();
    const res = await post(appWith(l), { reads: [{ gasUsed: 0, responseBytes: 0, count: 100000 }] }, "HUBKEY");
    expect(res.status).toBe(400);
    expect(l.byConsumer()).toEqual({});
  });
});
