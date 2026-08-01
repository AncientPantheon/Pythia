import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { encryptStringV2 } from "@stoachain/stoa-core/crypto";
import type { IOuroAccount } from "@ancientpantheon/codex/ouronet";
import { DUAL_LINK_BAR } from "@ancientpantheon/pythia-client";
import { ensureSodiumReady, parseMasterKey } from "../codex/vault.js";
import { SealedStore } from "../codex/sealedStore.js";
import { CodexStore } from "./codexStore.js";
import { SelfApolloVault } from "./selfApollo.js";
import { createInProcessFetch } from "../connectors/self/inProcessFetch.js";
import { SelfConnectorLoop } from "./selfConnectorLoop.js";

const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const BASE_URL = "http://pythia.self";

let dir: string;
const store = () => new SealedStore({ dir, keyProvider: () => parseMasterKey(KEY) });
const codex = () => new CodexStore(store());

beforeAll(async () => {
  await ensureSodiumReady();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pythia-selfconnectorloop-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Builds real, independently-generated Standard + Smart Apollo accounts
 * (mirrors `selfApollo.test.ts`'s own `seedCodexWithHalves` fixture-building
 * approach — genuine keypairs, encrypted via `encryptStringV2`, real
 * `originMode`/`originCurve` fields Codex needs to re-derive; duplicated here
 * rather than cross-imported from a sibling test file, per this topic's own
 * plan). Seeds `c`'s snapshot with only whichever of `which` are requested
 * (default: both) — a caller can request just one half seeded while still
 * getting BOTH accounts' addresses back, to build a well-formed-but-not-
 * codex-held half for the "missing half" test.
 */
async function seedCodexWithHalves(
  c: CodexStore,
  which: readonly ("standard" | "smart")[] = ["standard", "smart"],
): Promise<{ standardAccount: string; smartAccount: string }> {
  const registry = await import("@ouronet/dalos-crypto/registry");
  const codexPassword = c.getOrCreateCodexPassword();

  const standardFull = registry.Apollo.generateRandom();
  const smartFull = registry.Apollo.generateRandom();

  const accounts: IOuroAccount[] = [];
  if (which.includes("standard")) {
    accounts.push({
      id: "test-self-standard",
      version: "1.0",
      isSmart: false,
      address: standardFull.standardAddress,
      guard: null,
      stoaChainLedger: null,
      publicKey: standardFull.keyPair.publ,
      secret: await encryptStringV2(standardFull.privateKey.bitString, codexPassword),
      backup: "",
      originMode: "bitString",
      originCurve: "apollo",
    });
  }
  if (which.includes("smart")) {
    accounts.push({
      id: "test-self-smart",
      version: "1.0",
      isSmart: true,
      address: smartFull.smartAddress,
      guard: null,
      stoaChainLedger: null,
      publicKey: smartFull.keyPair.publ,
      secret: await encryptStringV2(smartFull.privateKey.bitString, codexPassword),
      backup: "",
      originMode: "bitString",
      originCurve: "apollo",
    });
  }
  c.saveBackup(JSON.stringify({ ouroAccounts: accounts }));

  return { standardAccount: standardFull.standardAddress, smartAccount: smartFull.smartAddress };
}

const seedCodexWithRealPair = (c: CodexStore) => seedCodexWithHalves(c, ["standard", "smart"]);

/** Builds the well-formed dual-link-key for a seeded pair's own two
 * addresses, joined via the SDK's own `DUAL_LINK_BAR` separator. */
function keyFor(pair: { standardAccount: string; smartAccount: string }): string {
  return `${pair.standardAccount}${DUAL_LINK_BAR}${pair.smartAccount}`;
}

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

describe("SelfConnectorLoop — status() before any dual-link-key is set", () => {
  it("reports not-linked for both halves for a fresh vault (no codex seeding needed)", () => {
    const vault = new SelfApolloVault(store(), codex());
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
});

describe("SelfConnectorLoop — tick() with no dual-link-key set", () => {
  it("ever resolves without throwing, verifyCalls stays empty, status stays not-linked for both halves (mirror-image of the retired self-derivation: this topic's whole point is that the paste is the ONLY source of truth)", async () => {
    const vault = new SelfApolloVault(store(), codex());
    const { app, verifyCalls } = buildStubApp();
    const loop = new SelfConnectorLoop({
      baseUrl: BASE_URL,
      fetchImpl: createInProcessFetch(app),
      vault,
    });

    await expect(loop.tick()).resolves.toBeUndefined();
    expect(verifyCalls).toHaveLength(0);
    expect(loop.status()).toEqual({
      standard: { status: "not-linked" },
      smart: { status: "not-linked" },
    });
  });
});

describe("SelfConnectorLoop — tick()", () => {
  it("pre-tick status is not yet active even though a real, codex-held pair is linked", async () => {
    const c = codex();
    const pair = await seedCodexWithRealPair(c);
    const vault = new SelfApolloVault(store(), c);
    vault.setDualLinkKey(keyFor(pair));
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
    const c = codex();
    const pair = await seedCodexWithRealPair(c);
    const { standardAccount, smartAccount } = pair;
    const vault = new SelfApolloVault(store(), c);
    vault.setDualLinkKey(keyFor(pair));
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

  it("codex decommissioned (cleared) AFTER a successful link but BEFORE any tick: tick() resolves without throwing, and status() reports pending (not active, not a crash) for both halves", async () => {
    // `setDualLinkKey` only validates codexHoldsAccount() ONCE, at paste
    // time — it never re-checks later. In production an operator can link,
    // then separately hit the Codex tab's decommission control (a real,
    // reachable `DELETE /admin/codex` route, `codexAdmin.ts`), silently
    // invalidating the signing material this loop depends on. This proves
    // the resulting tick() degrades gracefully (via DualLinkConnector's own
    // per-half error isolation) rather than throwing unhandled or somehow
    // reporting "active" with no real secret behind it.
    const c = codex();
    const pair = await seedCodexWithRealPair(c);
    const vault = new SelfApolloVault(store(), c);
    vault.setDualLinkKey(keyFor(pair)); // succeeds — codex holds both halves right now

    c.clearCodex(); // decommissioned — codexApolloSigner's loadSnapshot will now throw

    const { app } = buildStubApp();
    const loop = new SelfConnectorLoop({
      baseUrl: BASE_URL,
      fetchImpl: createInProcessFetch(app),
      vault,
    });

    await expect(loop.tick()).resolves.toBeUndefined(); // never an unhandled rejection
    const status = loop.status();
    expect(status.standard).toEqual({ status: "pending" }); // never reached active — signing failed
    expect(status.smart).toEqual({ status: "pending" });
  });

  it("a half held by the codex but the OTHER half not held at all: setDualLinkKey itself rejects (per this topic's new validation boundary) rather than silently producing a not-linked, non-throwing state", async () => {
    const c = codex();
    const pair = await seedCodexWithHalves(c, ["standard"]); // only the standard half is actually held
    const vault = new SelfApolloVault(store(), c);

    expect(() => vault.setDualLinkKey(keyFor(pair))).toThrow(/not held by Pythia's own Codex/);
    expect(() => vault.setDualLinkKey(keyFor(pair))).toThrow(/smart/);
    expect(vault.dualLinkKey()).toBeNull();

    // Since the key was never sealed, tick() has nothing to derive from —
    // stays a no-op, mirroring the "no dual-link-key set" describe block.
    const { app, verifyCalls } = buildStubApp();
    const loop = new SelfConnectorLoop({
      baseUrl: BASE_URL,
      fetchImpl: createInProcessFetch(app),
      vault,
    });
    await expect(loop.tick()).resolves.toBeUndefined();
    expect(verifyCalls).toHaveLength(0);
    expect(loop.status()).toEqual({
      standard: { status: "not-linked" },
      smart: { status: "not-linked" },
    });
  });

  it("the MIRROR case: only the SMART half is held by the codex — setDualLinkKey rejects naming 'standard' (guard is symmetric, not just checked one-sided)", async () => {
    const c = codex();
    const pair = await seedCodexWithHalves(c, ["smart"]); // only the smart half is actually held
    const vault = new SelfApolloVault(store(), c);

    expect(() => vault.setDualLinkKey(keyFor(pair))).toThrow(/not held by Pythia's own Codex/);
    expect(() => vault.setDualLinkKey(keyFor(pair))).toThrow(/standard/);
    expect(vault.dualLinkKey()).toBeNull();
  });

  it("isolates a half's verify failure: the failing half's status stays unchanged while the other half still goes active, and the log names the FAILING half specifically", async () => {
    const c = codex();
    const pair = await seedCodexWithRealPair(c);
    const { standardAccount } = pair;
    const vault = new SelfApolloVault(store(), c);
    vault.setDualLinkKey(keyFor(pair));
    const { app } = buildStubApp({ failAccount: standardAccount });
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

  it("a half reported PENDING by the server (proven ownership, not yet an active dual link — the realistic steady state before the manual on-chain deploy+link step) is cached and reported, not lost as not-linked", async () => {
    const c = codex();
    const pair = await seedCodexWithRealPair(c);
    const { standardAccount, smartAccount } = pair;
    const vault = new SelfApolloVault(store(), c);
    vault.setDualLinkKey(keyFor(pair));
    const { app } = buildStubApp({ pendingAccount: standardAccount });
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
  // Deliberately REAL timers (not `vi.useFakeTimers()`, unlike this describe
  // block's pre-T2 version): `tick()` now drives a genuine Codex-backed sign
  // (dynamic import + real `smartDecrypt` key-derivation work,
  // `createCodexApolloSigner`/`autoSignApolloChallenge`) that takes real
  // wall-clock CPU time — `vi.advanceTimersByTimeAsync`'s microtask-flush
  // loop returns before that real work settles, producing flaky/incomplete
  // ticks. A short REAL `intervalMs` + `vi.waitFor` (already this codebase's
  // own convention for "fire-and-forget, don't assume instant settlement" —
  // see `selfConnectorIntegration.test.ts`) waits for the ACTUAL async chain
  // to finish instead of a simulated clock.

  it("start() drives tick()-work on the interval; stop() halts further ticks", async () => {
    const c = codex();
    const pair = await seedCodexWithRealPair(c);
    const vault = new SelfApolloVault(store(), c);
    vault.setDualLinkKey(keyFor(pair));
    const { app, verifyCalls } = buildStubApp();
    const loop = new SelfConnectorLoop({
      baseUrl: BASE_URL,
      fetchImpl: createInProcessFetch(app),
      vault,
      intervalMs: 20,
    });

    loop.start();
    expect(verifyCalls).toHaveLength(0); // no tick yet — only the interval fires it

    await vi.waitFor(() => {
      expect(verifyCalls.length).toBeGreaterThan(0);
    });
    const countAfterFirstTick = verifyCalls.length;

    loop.stop();
    await new Promise((resolve) => setTimeout(resolve, 150)); // real wait spanning several would-be intervals
    expect(verifyCalls).toHaveLength(countAfterFirstTick); // no further ticks after stop()
  });

  it("start() is idempotent — a second call while already running does not create a second timer", async () => {
    const c = codex();
    const pair = await seedCodexWithRealPair(c);
    const vault = new SelfApolloVault(store(), c);
    vault.setDualLinkKey(keyFor(pair));
    const { app, verifyCalls } = buildStubApp();
    const loop = new SelfConnectorLoop({
      baseUrl: BASE_URL,
      fetchImpl: createInProcessFetch(app),
      vault,
      intervalMs: 20,
    });

    loop.start();
    loop.start(); // second call — must be a no-op, not a second interval

    // A doubled timer would fire tick() twice per interval (4 verify calls —
    // 2 halves x 2 concurrent ticks); one timer fires it once (2 halves).
    await vi.waitFor(() => {
      expect(verifyCalls.length).toBeGreaterThanOrEqual(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 150)); // real wait — a doubled timer would keep piling up extra calls
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
    // catch this; it takes SEVERAL more interval firings to prove reuse.
    const c = codex();
    const pair = await seedCodexWithRealPair(c);
    const vault = new SelfApolloVault(store(), c);
    vault.setDualLinkKey(keyFor(pair));
    const { app, verifyCalls } = buildStubApp();
    const loop = new SelfConnectorLoop({
      baseUrl: BASE_URL,
      fetchImpl: createInProcessFetch(app),
      vault,
      intervalMs: 20,
    });

    loop.start();
    await vi.waitFor(() => {
      expect(verifyCalls.length).toBe(2); // both halves go active on the first tick
    });
    const countAfterFirstTick = verifyCalls.length;

    await new Promise((resolve) => setTimeout(resolve, 150)); // several more real interval firings — well within the 3h secret's refresh margin
    expect(verifyCalls.length).toBe(countAfterFirstTick); // NO new verify calls — the cached secret was reused

    loop.stop();
  });
});
