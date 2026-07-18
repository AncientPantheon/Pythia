import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { registerAdmin } from "./routes.js";
import { signSession } from "./session.js";
import { ConnectorStore } from "../connectors/store.js";
import type { OidcConfig } from "./oidcConfig.js";
import type { EnrichedNode } from "../hub/hubNodes.js";

const SECRET = "unit-test-session-secret-at-least-32-chars";
const tmpDirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "pyth-nodes-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NODES: EnrichedNode[] = [
  {
    id: "94.143.143.207",
    url: "https://94.143.143.207:1848",
    networkId: "stoa",
    operator: "k:abc",
    atTip: true,
    height: 5,
    reachable: false,
    reason: "timeout",
  },
];

function makeApp() {
  const app = new Hono();
  const dir = scratch();
  registerAdmin(
    app,
    { sessionSecret: SECRET } as OidcConfig,
    new ConnectorStore({ filePath: join(dir, "conn.json") }),
    { hubNodes: { list: async () => NODES } },
  );
  return app;
}

async function ancientCookie(): Promise<string> {
  const t = await signSession({ sub: "u1", roles: ["ancient"], name: "Ancient" }, SECRET);
  return `pythia_admin_session=${t}`;
}

describe("admin GET /admin/hub-nodes", () => {
  it("returns the enriched node list for an ancient", async () => {
    const res = await makeApp().request("/admin/hub-nodes", {
      headers: { cookie: await ancientCookie() },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as EnrichedNode[];
    expect(body).toEqual(NODES);
    expect(body[0].reason).toBe("timeout");
  });

  it("gates behind ancient — 401 without a session", async () => {
    expect((await makeApp().request("/admin/hub-nodes")).status).toBe(401);
  });

  it("403s a non-ancient session", async () => {
    const t = await signSession({ sub: "u2", roles: ["modern"], name: "M" }, SECRET);
    const res = await makeApp().request("/admin/hub-nodes", {
      headers: { cookie: `pythia_admin_session=${t}` },
    });
    expect(res.status).toBe(403);
  });
});
