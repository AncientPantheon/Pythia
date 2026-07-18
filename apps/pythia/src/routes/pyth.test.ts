import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { PythLedger } from "../pyth/ledger.js";
import { registerPyth } from "./pyth.js";

const tmpDirs: string[] = [];
function ledger(): PythLedger {
  const dir = mkdtempSync(join(tmpdir(), "pyth-route-"));
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

describe("GET /pyth", () => {
  it("returns the total + daily ledger view", async () => {
    const l = ledger();
    l.recordRead(10);
    l.recordSend(true, 1200);
    const app = new Hono();
    registerPyth(app, l);

    const res = await app.request("/pyth");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: Record<string, number>;
      daily: Array<{ day: string }>;
      generatedAt: string;
    };
    expect(body.total.petitions).toBe(1);
    expect(body.total.pondus).toBe(10);
    expect(body.total.transactions).toBe(1);
    expect(body.total.gasReserved).toBe(1200);
    expect(body.daily).toHaveLength(1);
    expect(body.daily[0].day).toBe("2026-07-05");
    expect(typeof body.generatedAt).toBe("string");
  });

  it("returns zeros / empty for a fresh ledger", async () => {
    const app = new Hono();
    registerPyth(app, ledger());
    const res = await app.request("/pyth");
    const body = (await res.json()) as { total: Record<string, number>; daily: unknown[] };
    expect(body.total.petitions).toBe(0);
    expect(body.total.pondus).toBe(0);
    expect(body.daily).toEqual([]);
  });
});
