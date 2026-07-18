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
  const d = mkdtempSync(join(tmpdir(), "pyth-ver-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeApp() {
  const app = new Hono();
  const dir = scratch();
  registerAdmin(
    app,
    { sessionSecret: SECRET } as OidcConfig,
    new ConnectorStore({ filePath: join(dir, "conn.json") }),
    {
      versionInfo: {
        get: async () => ({ installed: "1.11.0", available: "1.12.0", updateAvailable: true }),
      },
    },
  );
  return app;
}

async function ancientCookie(): Promise<string> {
  const t = await signSession({ sub: "u1", roles: ["ancient"], name: "Ancient" }, SECRET);
  return `pythia_admin_session=${t}`;
}

describe("admin GET /admin/version-info", () => {
  it("returns installed + available + updateAvailable for an ancient", async () => {
    const res = await makeApp().request("/admin/version-info", {
      headers: { cookie: await ancientCookie() },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ installed: "1.11.0", available: "1.12.0", updateAvailable: true });
  });

  it("gates behind ancient — 401 without a session, 403 for non-ancient", async () => {
    expect((await makeApp().request("/admin/version-info")).status).toBe(401);
    const t = await signSession({ sub: "u2", roles: ["modern"], name: "M" }, SECRET);
    const res = await makeApp().request("/admin/version-info", {
      headers: { cookie: `pythia_admin_session=${t}` },
    });
    expect(res.status).toBe(403);
  });
});
