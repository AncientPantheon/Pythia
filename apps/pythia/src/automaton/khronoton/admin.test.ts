import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { registerKhronotonAdmin } from "./admin.js";
import { CodexStore } from "../codexStore.js";
import { SealedStore } from "../../codex/sealedStore.js";
import { ensureSodiumReady, parseMasterKey } from "../../codex/vault.js";
import { signSession } from "../../admin/session.js";
import type { OidcConfig } from "../../admin/oidcConfig.js";

// This suite exercises the ADAPTER glue I wrote — the ancient gate wrapping every
// route + the method/path → handler routing — not the package handlers (covered by
// engine.test.ts + the package). The unmatched-route cases return before the engine
// is built, so no db/runtime/network is touched.
const SECRET = "unit-test-session-secret-at-least-32-chars";
const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const tmpDirs: string[] = [];

beforeAll(async () => {
  await ensureSodiumReady();
});
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), "pythia-khadmin-"));
  tmpDirs.push(dir);
  const codex = new CodexStore(new SealedStore({ dir, keyProvider: () => parseMasterKey(KEY) }));
  const app = new Hono();
  registerKhronotonAdmin(app, { sessionSecret: SECRET } as OidcConfig, codex);
  return { app };
}
async function ancientCookie(): Promise<string> {
  const t = await signSession({ sub: "u1", roles: ["ancient"], name: "Ancient" }, SECRET);
  return `pythia_admin_session=${t}`;
}

describe("Khronoton admin routes", () => {
  it("gates every route behind ancient (401 without a session)", async () => {
    const { app } = makeApp();
    expect((await app.request("/admin/khronoton")).status).toBe(401);
    expect((await app.request("/admin/khronoton/signers")).status).toBe(401);
    expect((await app.request("/admin/khronoton/abc")).status).toBe(401);
    expect((await app.request("/admin/khronoton", { method: "POST" })).status).toBe(401);
  });

  it("403s a non-ancient session", async () => {
    const { app } = makeApp();
    const t = await signSession({ sub: "u2", roles: ["modern"], name: "M" }, SECRET);
    const res = await app.request("/admin/khronoton/signers", {
      headers: { cookie: `pythia_admin_session=${t}` },
    });
    expect(res.status).toBe(403);
  });

  it("404s an unmatched route for an authenticated ancient (routing glue, no engine)", async () => {
    const { app } = makeApp();
    const cookie = await ancientCookie();
    // PATCH on the collection root — only GET (list) / POST (commit) exist there.
    expect((await app.request("/admin/khronoton", { method: "PATCH", headers: { cookie } })).status).toBe(404);
    // A 3-segment path that no route claims.
    expect((await app.request("/admin/khronoton/a/b/c", { headers: { cookie } })).status).toBe(404);
    // The recover shape requires exactly /:id/fires/:fireId/recover.
    expect((await app.request("/admin/khronoton/x/fires/y/nope", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    })).status).toBe(404);
  });
});
