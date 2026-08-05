import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { registerAdmin } from "./routes.js";
import { signSession } from "./session.js";
import { ConnectorStore } from "../connectors/store.js";
import { SettingsStore } from "./settingsStore.js";
import { SealedStore } from "../codex/sealedStore.js";
import { ensureSodiumReady, parseMasterKey } from "../codex/vault.js";
import type { OidcConfig } from "./oidcConfig.js";
import type { SecurityStatus } from "./settingsStore.js";

const SECRET = "unit-test-session-secret-at-least-32-chars";
const tmpDirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "pyth-sec-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SEALED: SecurityStatus = {
  mode: "sealed",
  unlocked: true,
  fingerprint: "abcd1234",
  sealedCount: 1,
  names: ["hubHmacSecret"],
  plaintextFallback: false,
};

function makeApp() {
  const state = { status: { ...SEALED }, cleared: false };
  const app = new Hono();
  const dir = scratch();
  registerAdmin(
    app,
    { sessionSecret: SECRET } as OidcConfig,
    new ConnectorStore({ filePath: join(dir, "conn.json") }),
    {
      security: {
        status: () =>
          state.cleared
            ? { ...state.status, sealedCount: 0, names: [] }
            : state.status,
        clear: () => {
          state.cleared = true;
        },
      },
    },
  );
  return { app, state };
}

async function ancientCookie(): Promise<string> {
  const t = await signSession({ sub: "u1", roles: ["ancient"], name: "Ancient" }, SECRET);
  return `pythia_admin_session=${t}`;
}

describe("admin Security (sealed vault) endpoints", () => {
  it("GET /admin/security returns the vault status for an ancient", async () => {
    const { app } = makeApp();
    const res = await app.request("/admin/security", {
      headers: { cookie: await ancientCookie() },
    });
    expect(res.status).toBe(200);
    // The route is a verbatim pass-through of the injected status.
    const body = (await res.json()) as SecurityStatus;
    expect(body).toEqual(SEALED);
  });

  it("POST /admin/security/clear clears the vault and returns the new status", async () => {
    const { app, state } = makeApp();
    const res = await app.request("/admin/security/clear", {
      method: "POST",
      headers: { cookie: await ancientCookie() },
    });
    expect(res.status).toBe(200);
    expect(state.cleared).toBe(true);
    const body = (await res.json()) as SecurityStatus;
    expect(body.sealedCount).toBe(0);
    expect(body.names).toEqual([]);
  });

  it("gates both behind ancient (401 without a session)", async () => {
    const { app } = makeApp();
    expect((await app.request("/admin/security")).status).toBe(401);
    expect((await app.request("/admin/security/clear", { method: "POST" })).status).toBe(401);
  });

  it("403s a non-ancient session", async () => {
    const { app } = makeApp();
    const t = await signSession({ sub: "u2", roles: ["modern"], name: "M" }, SECRET);
    const res = await app.request("/admin/security/clear", {
      method: "POST",
      headers: { cookie: `pythia_admin_session=${t}` },
    });
    expect(res.status).toBe(403);
  });
});

describe("admin Security clear — scoped to the hub secret, not the whole shared vault", () => {
  const KEY = Buffer.from(new Uint8Array(32).fill(5)).toString("base64");

  beforeAll(async () => {
    await ensureSodiumReady();
  });

  // Wires `security.clear` exactly the way index.ts wires it (settingsStore.setHubConfig
  // with an empty secret) against a REAL SealedStore shared with a stand-in for another
  // subsystem's custody (e.g. the Codex organ's signing password) — the scenario that
  // regressed when `clear` was wired to the vault-wide `sealedVault.clear()` instead.
  function makeRealApp() {
    const dir = scratch();
    const vault = new SealedStore({
      dir: join(dir, "vault"),
      keyProvider: () => parseMasterKey(KEY),
    });
    const settings = new SettingsStore({ filePath: join(dir, "settings.json"), vault });
    settings.setHubConfig({ hmacSecret: "hubSecret1" });
    vault.set("codexPassword", "codex-signing-secret-untouched"); // another subsystem's entry

    const app = new Hono();
    registerAdmin(
      app,
      { sessionSecret: SECRET } as OidcConfig,
      new ConnectorStore({ filePath: join(dir, "conn.json") }),
      {
        security: {
          status: () => settings.securityStatus(),
          clear: () => settings.setHubConfig({ hmacSecret: "" }),
        },
      },
    );
    return { app, settings, vault };
  }

  it("clears the hub secret but leaves another entry sharing the vault intact", async () => {
    const { app, settings, vault } = makeRealApp();
    const res = await app.request("/admin/security/clear", {
      method: "POST",
      headers: { cookie: await ancientCookie() },
    });
    expect(res.status).toBe(200);
    expect(settings.hasSecret()).toBe(false);
    expect(vault.get("codexPassword")).toBe("codex-signing-secret-untouched");
  });
});
