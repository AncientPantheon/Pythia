import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { EphemeralKeyStore } from "./ephemeralKeyStore.js";
import { ConnectorStore } from "../store.js";
import { connectorGateMiddleware } from "./gateMiddleware.js";
import { firstPartyKeyMiddleware } from "./effectiveKey.js";
import { makeResolveConsumer, type ReadConsumerResolver } from "../../stats/consumerResolver.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshConnectorStore(): ConnectorStore {
  const dir = mkdtempSync(join(tmpdir(), "pythia-gate-"));
  tmpDirs.push(dir);
  return new ConnectorStore({ filePath: join(dir, "connectors.json") });
}

/** A real resolver over the given stores (+ optional self secret) — the same one
 * the gate uses in production, so the test exercises actual recognition. */
const MARKER = "fp_test_marker";

function resolverFor(
  eph: EphemeralKeyStore,
  conn: ConnectorStore,
  selfSecret: string | null = null,
): ReadConsumerResolver {
  return makeResolveConsumer({
    selfSecret: () => selfSecret,
    resolveEphemeral: (s) => eph.resolve(s),
    nameForKey: (k) => conn.nameForKey(k),
    envConsumer: () => undefined,
    selfLabel: "pythia-self",
    firstPartyMarker: MARKER,
  });
}

function appWith(resolve: ReadConsumerResolver, selfSecret: string | null = null): Hono {
  const app = new Hono();
  app.use("*", firstPartyKeyMiddleware(() => selfSecret, MARKER));
  app.use("*", connectorGateMiddleware(resolve));
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.post("/stoachain/read", (c) => c.json({ ok: true }));
  return app;
}

describe("connectorGateMiddleware (hardened)", () => {
  it("passes through a non-operational path unchanged, even with a bogus key header", async () => {
    const app = appWith(resolverFor(new EphemeralKeyStore(), freshConnectorStore()));
    const res = await app.request("/healthz", { headers: { "x-pythia-key": "not-a-real-key" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("REJECTS an operational request with NO key header (the hardening — was 200)", async () => {
    const app = appWith(resolverFor(new EphemeralKeyStore(), freshConnectorStore()));
    const res = await app.request("/stoachain/read", { method: "POST" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "a valid connector API key is required" });
  });

  it("rejects an operational request with an unknown/expired key and never reaches the handler", async () => {
    let handlerCalled = false;
    const app = new Hono();
    app.use("*", connectorGateMiddleware(resolverFor(new EphemeralKeyStore(), freshConnectorStore())));
    app.post("/stoachain/read", (c) => {
      handlerCalled = true;
      return c.json({ ok: true });
    });
    const res = await app.request("/stoachain/read", {
      method: "POST",
      headers: { "x-pythia-key": "pk_eph_unknown-or-expired" },
    });
    expect(res.status).toBe(401);
    // A PRESENTED-but-stale key returns the SDK-self-heal-matched message so a
    // refreshable client re-mints + retries (must stay in lockstep with the client's
    // transport.ts INVALID_KEY_ERROR).
    expect(await res.json()).toEqual({ error: "invalid or expired connector key" });
    expect(handlerCalled).toBe(false);
  });

  it("passes an operational request whose key resolves via a real EphemeralKeyStore", async () => {
    const eph = new EphemeralKeyStore();
    const { secret } = eph.issue("₱.consumer-a");
    const app = appWith(resolverFor(eph, freshConnectorStore()));
    const res = await app.request("/stoachain/read", {
      method: "POST",
      headers: { "x-pythia-key": secret },
    });
    expect(res.status).toBe(200);
  });

  it("passes a PRE-EXISTING permanent pk_live_ key (ConnectorStore) — the live fleet must not break", async () => {
    const conn = freshConnectorStore();
    const { apiKey } = conn.add({ name: "existing-connector", url: "https://example.com", isPublic: false });
    const app = appWith(resolverFor(new EphemeralKeyStore(), conn));
    const res = await app.request("/stoachain/read", {
      method: "POST",
      headers: { "x-pythia-key": apiKey },
    });
    expect(res.status).toBe(200);
  });

  it("passes a caller presenting Pythia's own self secret explicitly", async () => {
    const app = appWith(resolverFor(new EphemeralKeyStore(), freshConnectorStore(), "SELF-SECRET"), "SELF-SECRET");
    const res = await app.request("/stoachain/read", {
      method: "POST",
      headers: { "x-pythia-key": "SELF-SECRET" },
    });
    expect(res.status).toBe(200);
  });

  it("INJECTS the self key for a same-origin keyless read → served as pythia-self", async () => {
    // Pythia's own website: keyless fetch, Sec-Fetch-Site: same-origin. The
    // firstPartyKeyMiddleware injects her self secret so the gate lets it through.
    const app = appWith(resolverFor(new EphemeralKeyStore(), freshConnectorStore(), "SELF-SECRET"), "SELF-SECRET");
    const res = await app.request("/stoachain/read", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(200);
  });

  it("does NOT inject for a cross-site keyless read → still rejected", async () => {
    const app = appWith(resolverFor(new EphemeralKeyStore(), freshConnectorStore(), "SELF-SECRET"), "SELF-SECRET");
    const res = await app.request("/stoachain/read", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(401);
  });

  it("SERVES a same-origin keyless read even with NO active self secret (marker robustness)", async () => {
    // The failure mode this guards: right after a deploy the self secret is briefly
    // absent. Pythia's own site must NOT go dark — the marker keeps same-origin reads
    // served (as pythia-self, unkeyed) until the self-connector re-mints.
    const app = appWith(resolverFor(new EphemeralKeyStore(), freshConnectorStore(), null), null);
    const res = await app.request("/stoachain/read", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(200);
  });
});
