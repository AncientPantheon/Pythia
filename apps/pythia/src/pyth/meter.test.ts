import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import { PythLedger } from "./ledger.js";
import {
  pythMeterMiddleware,
  gasFromLocalResponse,
  reservedGasForCmds,
} from "./meter.js";

const tmpDirs: string[] = [];
function ledger(): PythLedger {
  const dir = mkdtempSync(join(tmpdir(), "pyth-meter-"));
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

// Consumer resolver: any key → a named consumer; none → the anonymous "direct".
const resolve = (k?: string) => (k ? "acme" : "direct");

function appWith(l: PythLedger, handler: (c: Context) => Response | Promise<Response>) {
  const app = new Hono();
  app.use("*", pythMeterMiddleware(l, resolve));
  app.post("/stoachain/read", handler);
  app.post("/stoachain/poll", handler);
  app.post("/stoachain/send", handler);
  return app;
}

describe("gasFromLocalResponse", () => {
  it("extracts a top-level gas field", () => {
    expect(gasFromLocalResponse(JSON.stringify({ gas: 500000, result: {} }))).toBe(500000);
  });
  it("returns 0 for missing / invalid / non-JSON", () => {
    expect(gasFromLocalResponse("{}")).toBe(0);
    expect(gasFromLocalResponse("not json")).toBe(0);
    expect(gasFromLocalResponse(JSON.stringify({ gas: -5 }))).toBe(0);
  });
});

describe("reservedGasForCmds", () => {
  it("sums gasLimit across the caller's cmds", () => {
    const cmds = [
      { cmd: JSON.stringify({ meta: { gasLimit: 1500 } }) },
      { cmd: JSON.stringify({ meta: { gasLimit: 500 } }) },
    ];
    expect(reservedGasForCmds(cmds)).toEqual({ txCount: 2, gasLimit: 2000 });
  });
  it("still counts a malformed cmd but adds no gas for it", () => {
    const cmds = [{ cmd: "nope" }, { cmd: JSON.stringify({ meta: { gasLimit: 300 } }) }];
    expect(reservedGasForCmds(cmds)).toEqual({ txCount: 2, gasLimit: 300 });
  });
  it("returns zeros for a non-array", () => {
    expect(reservedGasForCmds(undefined)).toEqual({ txCount: 0, gasLimit: 0 });
  });
});

describe("pythMeterMiddleware", () => {
  it("meters a keyed read as a petition + pondus (classBase 10 + gas + bytes)", async () => {
    const l = ledger();
    const app = appWith(l, (c) => c.json({ gas: 500000, result: { status: "success", data: 1 } }));
    const res = await app.request("/stoachain/read", {
      method: "POST",
      headers: { "x-pythia-key": "K" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const t = l.total();
    expect(t.petitions).toBe(1);
    expect(t.pondus).toBeGreaterThan(363); // 10 + √500000/2 + bytes/4096
  });

  it("does NOT meter an anonymous read (no key)", async () => {
    const l = ledger();
    const app = appWith(l, (c) => c.json({ gas: 100, result: {} }));
    await app.request("/stoachain/read", { method: "POST", body: "{}" });
    expect(l.total().petitions).toBe(0);
  });

  it("meters a keyed poll with classBase 5 and no gas", async () => {
    const l = ledger();
    const app = appWith(l, (c) => c.json({ requestKey: { result: { status: "success" } } }));
    await app.request("/stoachain/poll", { method: "POST", headers: { "x-pythia-key": "K" }, body: "{}" });
    const t = l.total();
    expect(t.petitions).toBe(1);
    expect(t.pondus).toBeGreaterThan(5); // 5 + bytes/4096
    expect(t.pondus).toBeLessThan(6);
  });

  it("does not meter a read that errored (>=400)", async () => {
    const l = ledger();
    const app = appWith(l, (c) => c.json({ error: "x" }, 502));
    await app.request("/stoachain/read", { method: "POST", headers: { "x-pythia-key": "K" }, body: "{}" });
    expect(l.total().petitions).toBe(0);
  });

  it("meters an accepted send as transactions + gasReserved", async () => {
    const l = ledger();
    const app = appWith(l, (c) => c.json({ requestKeys: ["rk"] }));
    const cmds = [{ cmd: JSON.stringify({ meta: { gasLimit: 1200 } }) }];
    await app.request("/stoachain/send", { method: "POST", body: JSON.stringify({ cmds }) });
    const t = l.total();
    expect(t.transactions).toBe(1);
    expect(t.gasReserved).toBe(1200);
    expect(t.failedTransactions).toBe(0);
  });

  it("meters a relay-failed send (502) as failed + wasted", async () => {
    const l = ledger();
    const app = appWith(l, (c) => c.json({ error: "pool" }, 502));
    const cmds = [
      { cmd: JSON.stringify({ meta: { gasLimit: 800 } }) },
      { cmd: JSON.stringify({ meta: { gasLimit: 200 } }) },
    ];
    await app.request("/stoachain/send", { method: "POST", body: JSON.stringify({ cmds }) });
    const t = l.total();
    expect(t.failedTransactions).toBe(2);
    expect(t.wastedGasReserved).toBe(1000);
    expect(t.transactions).toBe(0);
  });

  it("does not meter a send with no relay attempt (503 no sender)", async () => {
    const l = ledger();
    const app = appWith(l, (c) => c.json({ error: "no sender" }, 503));
    await app.request("/stoachain/send", {
      method: "POST",
      body: JSON.stringify({ cmds: [{ cmd: JSON.stringify({ meta: { gasLimit: 100 } }) }] }),
    });
    const t = l.total();
    expect(t.transactions).toBe(0);
    expect(t.failedTransactions).toBe(0);
  });

  it("with a tracker, an accepted send's requestKeys go to the tracker (NOT counted at relay)", async () => {
    const l = ledger();
    const tracked: Array<{ requestKey: string; gasLimit: number }> = [];
    const tracker = { track: (e: Array<{ requestKey: string; gasLimit: number }>) => tracked.push(...e) };
    const app = new Hono();
    app.use("*", pythMeterMiddleware(l, resolve, tracker));
    app.post("/stoachain/send", (c) => c.json({ requestKeys: ["RK-A", "RK-B"] }));
    const cmds = [
      { cmd: JSON.stringify({ meta: { gasLimit: 800 } }) },
      { cmd: JSON.stringify({ meta: { gasLimit: 200 } }) },
    ];
    await app.request("/stoachain/send", { method: "POST", body: JSON.stringify({ cmds }) });
    expect(l.total().transactions).toBe(0); // the tracker owns the outcome now
    expect(tracked).toEqual([
      { requestKey: "RK-A", gasLimit: 800 },
      { requestKey: "RK-B", gasLimit: 200 },
    ]);
  });

  it("with a tracker, a relay-rejected send is still counted failed at relay", async () => {
    const l = ledger();
    const tracker = { track: () => {} };
    const app = new Hono();
    app.use("*", pythMeterMiddleware(l, resolve, tracker));
    app.post("/stoachain/send", (c) => c.json({ error: "x" }, 502));
    await app.request("/stoachain/send", {
      method: "POST",
      body: JSON.stringify({ cmds: [{ cmd: JSON.stringify({ meta: { gasLimit: 500 } }) }] }),
    });
    expect(l.total().failedTransactions).toBe(1);
    expect(l.total().wastedGasReserved).toBe(500);
  });

  it("ignores non-operational paths", async () => {
    const l = ledger();
    const app = new Hono();
    app.use("*", pythMeterMiddleware(l, resolve));
    app.get("/healthz", (c) => c.json({ ok: true }));
    await app.request("/healthz", { headers: { "x-pythia-key": "K" } });
    expect(l.total().petitions).toBe(0);
  });
});
