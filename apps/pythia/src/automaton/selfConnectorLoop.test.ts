import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { DUAL_LINK_BAR } from "@ancientpantheon/pythia-client";
import { ensureSodiumReady, parseMasterKey } from "../codex/vault.js";
import { SealedStore } from "../codex/sealedStore.js";
import { SelfApolloVault } from "./selfApollo.js";
import { createInProcessFetch } from "../connectors/self/inProcessFetch.js";
import { SelfConnectorLoop } from "./selfConnectorLoop.js";

const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const BASE_URL = "http://pythia.self";

let dir: string;
const store = () => new SealedStore({ dir, keyProvider: () => parseMasterKey(KEY) });

beforeAll(async () => {
  await ensureSodiumReady();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pythia-selfconnectorloop-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A minimal fake connector-auth server: NOT `registerConnectorAuth` (that's
 * Topic 1/2's own server logic, already tested elsewhere) — just a well-formed
 * 200 challenge + verify pair, scoped to proving THIS loop composes correctly.
 * `failAccount`, when set, makes the verify route answer 401 for that one
 * apollo account only (proves per-half isolation).
 */
function buildStubApp(opts: { failAccount?: string; pendingAccount?: string } = {}) {
  const app = new Hono();
  const verifyCalls: string[] = [];

  app.post("/connectors/auth/challenge", async (c) => {
    return c.json({ nonce: "test-nonce", rp: "pythia.ancientholdings.eu", expiresAt: Date.now() + 900_000 });
  });

  app.post("/connectors/auth/verify", async (c) => {
    const body = (await c.req.json()) as { apolloAccount: string };
    verifyCalls.push(body.apolloAccount);
    if (opts.failAccount && body.apolloAccount === opts.failAccount) {
      return c.json({ error: "signature verification failed" }, 401);
    }
    if (opts.pendingAccount && body.apolloAccount === opts.pendingAccount) {
      // Mirrors the REAL server's 202 — ownership proven, but the on-chain
      // dual link isn't active yet. This is Pythia's own realistic starting
      // state (design.md: "neither of Pythia's own accounts is active yet")
      // and can persist for however long the manual on-chain deploy+link
      // step takes — it is not a rare/edge outcome, it's the common one.
      return c.json({ error: "ownership proven, but not yet an active dual link — no secret issued" }, 202);
    }
    return c.json({ secret: `secret-for-${body.apolloAccount}`, expiresAt: Date.now() + 3 * 60 * 60 * 1000 });
  });

  return { app, verifyCalls };
}

/** Builds the well-formed dual-link-key for `accounts` (`vault.ensureGenerated()`'s
 * result), joined via the SDK's own `DUAL_LINK_BAR` separator. */
function keyFor(accounts: { standardAccount: string | null; smartAccount: string | null }): string {
  return `${accounts.standardAccount}${DUAL_LINK_BAR}${accounts.smartAccount}`;
}

describe("SelfConnectorLoop — status() before generation", () => {
  it("reports not-generated for both halves when the vault has never been generated", () => {
    const vault = new SelfApolloVault(store());
    const { app } = buildStubApp();
    const loop = new SelfConnectorLoop({
      baseUrl: BASE_URL,
      fetchImpl: createInProcessFetch(app),
      vault,
    });
    expect(loop.status()).toEqual({
      standard: { status: "not-generated" },
      smart: { status: "not-generated" },
    });
  });
});

describe("SelfConnectorLoop — status() after generation, before linking", () => {
  it("reports not-linked for BOTH halves once the vault is generated but setDualLinkKey has never been called", async () => {
    const vault = new SelfApolloVault(store());
    await vault.ensureGenerated();
    const { app } = buildStubApp();
    const loop = new SelfConnectorLoop({
      baseUrl: BASE_URL,
      fetchImpl: createInProcessFetch(app),
      vault,
    });

    expect(loop.status()).toEqual({
      standard: { status: "not-linked" },
      smart: { status: "not-linked" },
    });
  });

  it("tick() with NO setDualLinkKey call ever made still drives both halves to active — the loop derives its OWN key from the vault's known accounts, it never waits for a paste (regression: an earlier version gated construction on vault.dualLinkKey() and broke the pre-link ownership-proof flow selfConnectorIntegration.test.ts depends on)", async () => {
    const vault = new SelfApolloVault(store());
    const { standardAccount, smartAccount } = await vault.ensureGenerated();
    const { app, verifyCalls } = buildStubApp();
    const loop = new SelfConnectorLoop({
      baseUrl: BASE_URL,
      fetchImpl: createInProcessFetch(app),
      vault,
    });

    await expect(loop.tick()).resolves.toBeUndefined();
    expect(verifyCalls).toHaveLength(2); // both halves DID attempt a challenge/verify — no paste required
    const status = loop.status();
    expect(status.standard).toMatchObject({ status: "active", secret: `secret-for-${standardAccount}` });
    expect(status.smart).toMatchObject({ status: "active", secret: `secret-for-${smartAccount}` });
  });
});

describe("SelfConnectorLoop — tick()", () => {
  it("pre-tick status is not yet active even though both halves are generated and linked", async () => {
    const vault = new SelfApolloVault(store());
    const accounts = await vault.ensureGenerated();
    vault.setDualLinkKey(keyFor(accounts));
    const { app } = buildStubApp();
    const loop = new SelfConnectorLoop({
      baseUrl: BASE_URL,
      fetchImpl: createInProcessFetch(app),
      vault,
    });

    const preTick = loop.status();
    expect(preTick.standard.status).not.toBe("active");
    expect(preTick.smart.status).not.toBe("active");

    await loop.tick();
    const postTick = loop.status();
    expect(postTick.standard.status).toBe("active");
    expect(postTick.smart.status).toBe("active");
  });

  it("after a successful tick, both halves report active with the stub's secret + expiresAt", async () => {
    const vault = new SelfApolloVault(store());
    const accounts = await vault.ensureGenerated();
    const { standardAccount, smartAccount } = accounts;
    vault.setDualLinkKey(keyFor(accounts));
    const { app } = buildStubApp();
    const loop = new SelfConnectorLoop({
      baseUrl: BASE_URL,
      fetchImpl: createInProcessFetch(app),
      vault,
    });

    await loop.tick();
    const status = loop.status();

    expect(status.standard).toMatchObject({
      status: "active",
      secret: `secret-for-${standardAccount}`,
    });
    expect(status.smart).toMatchObject({
      status: "active",
      secret: `secret-for-${smartAccount}`,
    });
    expect((status.standard as { expiresAt: number }).expiresAt).toBeGreaterThan(Date.now());
    expect((status.smart as { expiresAt: number }).expiresAt).toBeGreaterThan(Date.now());
  });

  it("a half missing entirely (never generated) means no valid dual-link-key can ever be set — tick() stays a no-op and neither half reaches active, but nothing throws", async () => {
    const s = store();
    const seedVault = new SelfApolloVault(s);
    await seedVault.ensureGenerated();
    s.delete("self-apollo-smart"); // only the standard half remains on disk

    const vault = new SelfApolloVault(s);
    const { app } = buildStubApp();
    const loop = new SelfConnectorLoop({
      baseUrl: BASE_URL,
      fetchImpl: createInProcessFetch(app),
      vault,
    });

    await expect(loop.tick()).resolves.toBeUndefined();
    const status = loop.status();
    // The standard account exists, but tick() can't derive a key (needs
    // BOTH halves) — stays "not-linked", never reaches the connector.
    expect(status.standard).toEqual({ status: "not-linked" });
    expect(status.smart).toEqual({ status: "not-generated" }); // no account at all
  });

  it("the MIRROR case: only the SMART half exists on disk — tick() stays a no-op for the same reason (guard is symmetric, not just checked one-sided)", async () => {
    // The sibling test above only ever deletes the smart half, leaving
    // standard behind — this proves the OTHER branch of `tick()`'s `if
    // (!standardAccount || !smartAccount) return;` guard, which a regression
    // checking only one side (e.g. `if (!standardAccount) return;`) would
    // still pass.
    const s = store();
    const seedVault = new SelfApolloVault(s);
    await seedVault.ensureGenerated();
    s.delete("self-apollo-standard"); // only the smart half remains on disk

    const vault = new SelfApolloVault(s);
    const { app } = buildStubApp();
    const loop = new SelfConnectorLoop({
      baseUrl: BASE_URL,
      fetchImpl: createInProcessFetch(app),
      vault,
    });

    await expect(loop.tick()).resolves.toBeUndefined();
    const status = loop.status();
    expect(status.standard).toEqual({ status: "not-generated" }); // no account at all
    expect(status.smart).toEqual({ status: "not-linked" }); // account exists, but can't derive a key alone
  });

  it("isolates a half's verify failure: the failing half's status stays unchanged while the other half still goes active, and the log names the FAILING half specifically", async () => {
    const vault = new SelfApolloVault(store());
    const accounts = await vault.ensureGenerated();
    const { standardAccount } = accounts;
    vault.setDualLinkKey(keyFor(accounts));
    const { app } = buildStubApp({ failAccount: standardAccount! });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const loop = new SelfConnectorLoop({
      baseUrl: BASE_URL,
      fetchImpl: createInProcessFetch(app),
      vault,
    });

    await expect(loop.tick()).resolves.toBeUndefined();
    const status = loop.status();

    expect(status.standard).toEqual({ status: "pending" }); // never succeeded — still the initial pending state
    expect(status.smart.status).toBe("active");
    // Regression: a bug that logged the wrong half (e.g. always "smart"
    // regardless of which one actually failed) would pass a bare
    // toHaveBeenCalled() unnoticed — assert the logged half by name.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"standard"'),
      expect.anything(),
    );
    errorSpy.mockRestore();
  });

  it("a half reported PENDING by the server (proven ownership, not yet an active dual link — the realistic steady state before the manual on-chain deploy+link step) is cached and reported, not lost as not-generated", async () => {
    const vault = new SelfApolloVault(store());
    const accounts = await vault.ensureGenerated();
    const { standardAccount, smartAccount } = accounts;
    vault.setDualLinkKey(keyFor(accounts));
    const { app } = buildStubApp({ pendingAccount: standardAccount! });
    const loop = new SelfConnectorLoop({
      baseUrl: BASE_URL,
      fetchImpl: createInProcessFetch(app),
      vault,
    });

    await loop.tick();
    const status = loop.status();

    expect(status.standard).toEqual({ status: "pending" });
    expect(status.smart).toMatchObject({
      status: "active",
      secret: `secret-for-${smartAccount}`,
    });
  });
});

describe("SelfConnectorLoop — start()/stop()", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("start() drives tick()-work on the interval; stop() halts further ticks", async () => {
    const vault = new SelfApolloVault(store());
    const accounts = await vault.ensureGenerated();
    vault.setDualLinkKey(keyFor(accounts));
    const { app, verifyCalls } = buildStubApp();
    const loop = new SelfConnectorLoop({
      baseUrl: BASE_URL,
      fetchImpl: createInProcessFetch(app),
      vault,
      intervalMs: 1000,
    });

    loop.start();
    expect(verifyCalls).toHaveLength(0); // no tick yet — only the interval fires it

    await vi.advanceTimersByTimeAsync(1000);
    expect(verifyCalls.length).toBeGreaterThan(0);
    const countAfterFirstTick = verifyCalls.length;

    loop.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(verifyCalls).toHaveLength(countAfterFirstTick); // no further ticks after stop()
  });

  it("start() is idempotent — a second call while already running does not create a second timer", async () => {
    const vault = new SelfApolloVault(store());
    const accounts = await vault.ensureGenerated();
    vault.setDualLinkKey(keyFor(accounts));
    const { app, verifyCalls } = buildStubApp();
    const loop = new SelfConnectorLoop({
      baseUrl: BASE_URL,
      fetchImpl: createInProcessFetch(app),
      vault,
      intervalMs: 1000,
    });

    loop.start();
    loop.start(); // second call — must be a no-op, not a second interval

    await vi.advanceTimersByTimeAsync(1000);
    // A doubled timer would fire tick() twice per interval (4 verify calls —
    // 2 halves x 2 concurrent ticks); one timer fires it once (2 halves).
    expect(verifyCalls.length).toBe(2);
    loop.stop();
  });

  it("reuses the SAME internal DualLinkConnector (built exactly once, lazily, off the vault's dual-link-key) across multiple ticks — does not rebuild + re-verify from scratch every interval", async () => {
    // Regression: plan.md's T3 explicitly requires the internal
    // `DualLinkConnector` be "constructed ONCE and reused across ticks (not
    // rebuilt every tick)." If a regression rebuilt it per tick (each with a
    // fresh, empty InMemorySecretStorage per half), every interval would
    // perform a full challenge->sign->verify round trip forever instead of
    // returning the cached secret cheaply once still within its refresh
    // margin — defeating the whole point of PythiaConnector's own caching
    // (inherited here through DualLinkConnector). A single-tick test can't
    // catch this; it takes a SECOND tick to prove reuse.
    const vault = new SelfApolloVault(store());
    const accounts = await vault.ensureGenerated();
    vault.setDualLinkKey(keyFor(accounts));
    const { app, verifyCalls } = buildStubApp();
    const loop = new SelfConnectorLoop({
      baseUrl: BASE_URL,
      fetchImpl: createInProcessFetch(app),
      vault,
      intervalMs: 1000,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(1000); // tick 1 — both halves go active
    const countAfterFirstTick = verifyCalls.length;
    expect(countAfterFirstTick).toBe(2);

    await vi.advanceTimersByTimeAsync(1000); // tick 2 — well within the 3h secret's refresh margin
    expect(verifyCalls.length).toBe(countAfterFirstTick); // NO new verify calls — the cached secret was reused

    loop.stop();
  });
});
