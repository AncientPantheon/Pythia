import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

// A throwing handler must not fall through to Hono's default unstructured 500 —
// the UI renders any non-2xx as an opaque "Simulation failed — network error."
// Mock two handlers to throw: an EXECUTION one (simulate → must surface as
// 200 {ok:false,error}) and a plain one (list → structured 500 {error}). Scoped
// to this file so `admin.test.ts`'s routing tests keep the real handlers.
vi.mock("@ancientpantheon/khronoton-core/handlers", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    simulateCodexTx: () => {
      throw new Error("boom-simulate");
    },
    listCodexCronotons: () => {
      throw new Error("boom-list");
    },
    // Mimics khronoton-core's own withConfirm→mapStoreError: the handler CATCHES
    // its internal throw and RETURNS a structured 500 (the throw never escapes).
    executeNow: async () => ({ status: 500, body: { error: "boom-returned-500" } }),
  };
});

const { registerKhronotonAdmin } = await import("./admin.js");
const { CodexStore } = await import("../codexStore.js");
const { SealedStore } = await import("../../codex/sealedStore.js");
const { ensureSodiumReady, parseMasterKey } = await import("../../codex/vault.js");
const { signSession } = await import("../../admin/session.js");
type OidcConfig = import("../../admin/oidcConfig.js").OidcConfig;

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
  const dir = mkdtempSync(join(tmpdir(), "pythia-kherr-"));
  tmpDirs.push(dir);
  const codex = new CodexStore(new SealedStore({ dir, keyProvider: () => parseMasterKey(KEY) }));
  const app = new Hono();
  registerKhronotonAdmin(app, { sessionSecret: SECRET } as OidcConfig, codex);
  return app;
}
async function ancientCookie(): Promise<string> {
  const t = await signSession({ sub: "u1", roles: ["ancient"], name: "Ancient" }, SECRET);
  return `pythia_admin_session=${t}`;
}

describe("Khronoton admin — handler-throw error surfacing", () => {
  it("a throwing EXECUTION handler (simulate) returns 200 with { ok:false, error } — the UI shows the real reason, never a generic 'network error'", async () => {
    const res = await makeApp().request("/admin/khronoton/simulate", {
      method: "POST",
      headers: { cookie: await ancientCookie(), "content-type": "application/json" },
      body: JSON.stringify({ envelope: {} }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, error: "boom-simulate" });
  });

  it("a throwing NON-execution handler (list) returns a structured 500 { error } instead of an unhandled crash", async () => {
    const res = await makeApp().request("/admin/khronoton", {
      headers: { cookie: await ancientCookie() },
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "boom-list" });
  });

  it("an execution handler that RETURNS a 500 (khronoton-core's withConfirm→mapStoreError shape) is re-emitted as 200 { ok:false, error } so the UI shows the real reason — the exact case a raw simulate 500 hid", async () => {
    const res = await makeApp().request("/admin/khronoton/some-id/execute", {
      method: "POST",
      headers: { cookie: await ancientCookie(), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, error: "boom-returned-500" });
  });
});
