import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { registerAdmin } from "./routes.js";
import { signSession } from "./session.js";
import { ConnectorStore } from "../connectors/store.js";
import type { OidcConfig } from "./oidcConfig.js";

const SECRET = "unit-test-session-secret-at-least-32-chars";
const tmpDirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "pyth-admin-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ZERO = {
  petitions: 0,
  pondus: 0,
  transactions: 0,
  gasReserved: 0,
  failedTransactions: 0,
  wastedGasReserved: 0,
};

// A simple in-memory Pyth control to exercise the endpoints + the gate.
function makeApp() {
  const state = {
    report: true,
    nuked: false,
    total: { ...ZERO, petitions: 5, pondus: 1.5, transactions: 2, gasReserved: 100 },
  };
  const app = new Hono();
  const dir = scratch();
  registerAdmin(
    app,
    { sessionSecret: SECRET } as OidcConfig,
    new ConnectorStore({ filePath: join(dir, "conn.json") }),
    {
      pyth: {
        total: () => (state.nuked ? { ...ZERO } : state.total),
        nuke: () => {
          state.nuked = true;
        },
        reportEnabled: () => state.report,
        setReportEnabled: (on) => {
          state.report = on;
        },
        unflushedDays: () => 0,
      },
    },
  );
  return { app, state };
}

async function ancientCookie(): Promise<string> {
  const t = await signSession({ sub: "u1", roles: ["ancient"], name: "Ancient" }, SECRET);
  return `pythia_admin_session=${t}`;
}

describe("admin StoaChain Earnings (Pyth) endpoints", () => {
  it("GET /admin/pyth returns totals + the report flag for an ancient", async () => {
    const { app } = makeApp();
    const res = await app.request("/admin/pyth", { headers: { cookie: await ancientCookie() } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: { petitions: number }; reportToHub: boolean };
    expect(body.total.petitions).toBe(5);
    expect(body.reportToHub).toBe(true);
  });

  it("POST /admin/pyth/nuke resets the ledger", async () => {
    const { app } = makeApp();
    const res = await app.request("/admin/pyth/nuke", {
      method: "POST",
      headers: { cookie: await ancientCookie() },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; total: { petitions: number } };
    expect(body.ok).toBe(true);
    expect(body.total.petitions).toBe(0);
  });

  it("POST /admin/pyth/report toggles the flag", async () => {
    const { app } = makeApp();
    const res = await app.request("/admin/pyth/report", {
      method: "POST",
      headers: { cookie: await ancientCookie(), "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reportToHub: boolean }).reportToHub).toBe(false);
  });

  it("rejects a report toggle with a non-boolean", async () => {
    const { app } = makeApp();
    const res = await app.request("/admin/pyth/report", {
      method: "POST",
      headers: { cookie: await ancientCookie(), "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(res.status).toBe(400);
  });

  it("gates all three behind ancient (401 without a session)", async () => {
    const { app } = makeApp();
    expect((await app.request("/admin/pyth")).status).toBe(401);
    expect((await app.request("/admin/pyth/nuke", { method: "POST" })).status).toBe(401);
    expect((await app.request("/admin/pyth/report", { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("403s a non-ancient session on nuke", async () => {
    const { app } = makeApp();
    const t = await signSession({ sub: "u2", roles: ["modern"], name: "M" }, SECRET);
    const res = await app.request("/admin/pyth/nuke", {
      method: "POST",
      headers: { cookie: `pythia_admin_session=${t}` },
    });
    expect(res.status).toBe(403);
  });
});
