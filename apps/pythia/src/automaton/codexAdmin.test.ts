import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { emptySnapshot } from "@ancientpantheon/codex/ouronet";
import { registerCodexAdmin } from "./codexAdmin.js";
import { CodexStore } from "./codexStore.js";
import { SealedStore } from "../codex/sealedStore.js";
import { ensureSodiumReady, parseMasterKey } from "../codex/vault.js";
import { signSession } from "../admin/session.js";
import type { OidcConfig } from "../admin/oidcConfig.js";

const SECRET = "unit-test-session-secret-at-least-32-chars";
const KEY = Buffer.from(new Uint8Array(32).fill(6)).toString("base64");
const tmpDirs: string[] = [];

beforeAll(async () => {
  await ensureSodiumReady();
});
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), "pythia-codexadmin-"));
  tmpDirs.push(dir);
  const codex = new CodexStore(new SealedStore({ dir, keyProvider: () => parseMasterKey(KEY) }));
  const app = new Hono();
  registerCodexAdmin(app, { sessionSecret: SECRET } as OidcConfig, codex);
  return { app, codex };
}

async function ancientCookie(): Promise<string> {
  const t = await signSession({ sub: "u1", roles: ["ancient"], name: "Ancient" }, SECRET);
  return `pythia_admin_session=${t}`;
}

describe("Codex admin routes", () => {
  it("GET /admin/codex returns the machine password + null backup for a fresh codex", async () => {
    const { app } = makeApp();
    const res = await app.request("/admin/codex", { headers: { cookie: await ancientCookie() } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { initialized: boolean; password: string; backup: unknown };
    expect(body.initialized).toBe(false);
    expect(Buffer.from(body.password, "base64")).toHaveLength(32);
    expect(body.backup).toBeNull();
  });

  it("POST then GET round-trips the sealed snapshot", async () => {
    const { app } = makeApp();
    const cookie = await ancientCookie();
    const blob = JSON.stringify(emptySnapshot("main"));
    const save = await app.request("/admin/codex", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ backup: blob }),
    });
    expect(save.status).toBe(200);
    const get = await app.request("/admin/codex", { headers: { cookie } });
    const body = (await get.json()) as { initialized: boolean; backup: string };
    expect(body.initialized).toBe(true);
    expect(body.backup).toBe(blob);
  });

  it("export re-encrypts under a chosen password and returns a downloadable blob", async () => {
    const { app } = makeApp();
    const cookie = await ancientCookie();
    await app.request("/admin/codex", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ backup: JSON.stringify(emptySnapshot("main")) }),
    });
    const res = await app.request("/admin/codex/export", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ newPassword: "operator-chosen-pass" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; filename: string; backup: string };
    expect(body.ok).toBe(true);
    expect(body.filename).toMatch(/^pythia-codex-.*\.json$/);
    expect(JSON.parse(body.backup).schemaVersion).toBeDefined();
  });

  it("export rejects a short newPassword (< 8)", async () => {
    const { app } = makeApp();
    const res = await app.request("/admin/codex/export", {
      method: "POST",
      headers: { cookie: await ancientCookie(), "content-type": "application/json" },
      body: JSON.stringify({ newPassword: "short" }),
    });
    expect(res.status).toBe(400);
  });

  it("import rejects a wallet-export envelope (not a raw snapshot) with 400", async () => {
    const { app } = makeApp();
    const res = await app.request("/admin/codex/import", {
      method: "POST",
      headers: { cookie: await ancientCookie(), "content-type": "application/json" },
      body: JSON.stringify({ backup: JSON.stringify({ kadenaWallets: [] }), filePassword: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("gates every route behind ancient (401 without a session)", async () => {
    const { app } = makeApp();
    expect((await app.request("/admin/codex")).status).toBe(401);
    expect((await app.request("/admin/codex/unlock")).status).toBe(401);
    expect((await app.request("/admin/codex", { method: "DELETE" })).status).toBe(401);
    expect((await app.request("/admin/codex/export", { method: "POST" })).status).toBe(401);
    expect((await app.request("/admin/codex/import", { method: "POST" })).status).toBe(401);
  });

  it("403s a non-ancient session", async () => {
    const { app } = makeApp();
    const t = await signSession({ sub: "u2", roles: ["modern"], name: "M" }, SECRET);
    const res = await app.request("/admin/codex", {
      headers: { cookie: `pythia_admin_session=${t}` },
    });
    expect(res.status).toBe(403);
  });
});
