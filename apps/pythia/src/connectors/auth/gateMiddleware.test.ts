import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { EphemeralKeyStore } from "./ephemeralKeyStore.js";
import { ConnectorStore } from "../store.js";
import { connectorGateMiddleware } from "./gateMiddleware.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshConnectorStore(): ConnectorStore {
  const dir = mkdtempSync(join(tmpdir(), "pythia-gate-"));
  tmpDirs.push(dir);
  return new ConnectorStore({ filePath: join(dir, "connectors.json") });
}

function appWith(ephemeralStore: EphemeralKeyStore, connectorStore: ConnectorStore): Hono {
  const app = new Hono();
  app.use("*", connectorGateMiddleware(ephemeralStore, connectorStore));
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.post("/stoachain/read", (c) => c.json({ ok: true }));
  return app;
}

describe("connectorGateMiddleware", () => {
  it("passes through a non-matching path unchanged, even with a bogus key header", async () => {
    // The gate must only ever look at operational read/send/poll paths — a
    // health check carrying a garbage key must not be affected at all.
    const app = appWith(new EphemeralKeyStore(), freshConnectorStore());

    const res = await app.request("/healthz", {
      headers: { "x-pythia-key": "not-a-real-key" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("passes an operational request through when no key header is present", async () => {
    // Decision 1: no header at all is today's open/"direct" behavior — must not regress.
    const app = appWith(new EphemeralKeyStore(), freshConnectorStore());

    const res = await app.request("/stoachain/read", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects an operational request with an unknown key and never reaches the handler", async () => {
    const app = new Hono();
    let handlerCalled = false;
    app.use("*", connectorGateMiddleware(new EphemeralKeyStore(), freshConnectorStore()));
    app.post("/stoachain/read", (c) => {
      handlerCalled = true;
      return c.json({ ok: true });
    });

    const res = await app.request("/stoachain/read", {
      method: "POST",
      headers: { "x-pythia-key": "pk_eph_unknown-or-expired" },
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid or expired connector key" });
    expect(handlerCalled).toBe(false);
  });

  it("passes an operational request through when the key resolves via a real EphemeralKeyStore", async () => {
    const ephemeralStore = new EphemeralKeyStore();
    const { secret } = ephemeralStore.issue("₱.consumer-a");
    const app = appWith(ephemeralStore, freshConnectorStore());

    const res = await app.request("/stoachain/read", {
      method: "POST",
      headers: { "x-pythia-key": secret },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("passes an operational request through when the key resolves via the PRE-EXISTING ConnectorStore (a permanent pk_live_ key, not one this gate itself issues)", async () => {
    // Regression guard: an ancient admin's already-registered connector must
    // keep working after this gate ships — it must not be silently 401'd just
    // because its key lives in ConnectorStore rather than EphemeralKeyStore.
    const connectorStore = freshConnectorStore();
    const { apiKey } = connectorStore.add({ name: "existing-connector", url: "https://example.com", isPublic: false });
    const app = appWith(new EphemeralKeyStore(), connectorStore);

    const res = await app.request("/stoachain/read", {
      method: "POST",
      headers: { "x-pythia-key": apiKey },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
