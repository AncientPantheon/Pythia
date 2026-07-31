import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

// `apolloVerify` is imported directly by the route (not injected via deps —
// see the design-choice comment in connectorAuth.ts), mirroring how
// connectorVerify.test.ts already mocks this same module rather than adding
// a route-level injection point. The sentinel "good-sig" lets tests drive
// both the success path and the real 401-on-bad-signature path deterministically.
vi.mock("../connectors/verify/apolloVerify.js", () => ({
  apolloVerify: vi.fn(async (sig: string) => sig === "good-sig"),
}));

import { registerConnectorAuth } from "./connectorAuth.js";
import { AuthNonceStore } from "../connectors/auth/nonceStore.js";
import { EphemeralKeyStore } from "../connectors/auth/ephemeralKeyStore.js";
import { DualLinkCache } from "../connectors/auth/dualLinkCache.js";

const STANDARD_PREFIX = "₱.";
const SMART_PREFIX = "Π.";

/** Build a syntactically valid 162-char apollo account (prefix + padded body). */
function apolloAccount(prefix: string, tag: string): string {
  return `${prefix}${tag.padEnd(160, "0")}`;
}

const ALICE = apolloAccount(STANDARD_PREFIX, "alice");
const BOB = apolloAccount(SMART_PREFIX, "bob");

/** A DualLinkCache pre-populated (via its real, injectable `poll`) so
 * `isActiveAccount` is true for exactly the given accounts. */
async function activeDualLinkCache(accounts: string[]): Promise<DualLinkCache> {
  const cache = new DualLinkCache({ poll: async () => new Set(accounts) });
  await cache.refreshNow();
  return cache;
}

function appWith(deps: {
  dualLinkCache: DualLinkCache;
  readApolloPublicKey?: (apolloAccount: string) => Promise<string>;
  readApolloCounterpart?: (apolloAccount: string) => Promise<string | null>;
  pendingActivation?: { recordProof(apolloAccount: string, counterpart: string): void };
}): { app: Hono; nonceStore: AuthNonceStore; ephemeralKeyStore: EphemeralKeyStore } {
  const app = new Hono();
  const nonceStore = new AuthNonceStore();
  const ephemeralKeyStore = new EphemeralKeyStore();
  registerConnectorAuth(app, {
    nonceStore,
    ephemeralKeyStore,
    dualLinkCache: deps.dualLinkCache,
    readApolloPublicKey: deps.readApolloPublicKey ?? (async (a) => `pub-for-${a}`),
    readApolloCounterpart: deps.readApolloCounterpart,
    pendingActivation: deps.pendingActivation,
  });
  return { app, nonceStore, ephemeralKeyStore };
}

async function challenge(app: Hono, apolloAccount: string): Promise<Response> {
  return app.request("/connectors/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apolloAccount }),
  });
}

async function verify(
  app: Hono,
  body: { apolloAccount: string; nonce: string; signature: string },
): Promise<Response> {
  return app.request("/connectors/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("connector auth (headless challenge/verify)", () => {
  it("completes a full challenge -> verify round trip and returns an ephemeral secret", async () => {
    const dualLinkCache = await activeDualLinkCache([ALICE]);
    const { app } = appWith({ dualLinkCache });

    const c = await challenge(app, ALICE);
    expect(c.status).toBe(200);
    const { nonce, rp, expiresAt } = (await c.json()) as {
      nonce: string;
      rp: string;
      expiresAt: number;
    };
    expect(nonce).toHaveLength(48);
    expect(rp).toBe("pythia.ancientholdings.eu");
    expect(expiresAt).toBeGreaterThan(Date.now());

    const v = await verify(app, { apolloAccount: ALICE, nonce, signature: "good-sig" });
    expect(v.status).toBe(200);
    const { secret, expiresAt: secretExpiresAt } = (await v.json()) as {
      secret: string;
      expiresAt: number;
    };
    expect(secret).toMatch(/^pk_eph_/);
    expect(secretExpiresAt).toBeGreaterThan(Date.now());
  });

  it("rejects a malformed apollo account on challenge with 400", async () => {
    const dualLinkCache = await activeDualLinkCache([]);
    const { app } = appWith({ dualLinkCache });

    // Wrong prefix and wrong length — neither is a valid ₱./Π.-prefixed 162-char account.
    const res = await challenge(app, "not-an-apollo-account");
    expect(res.status).toBe(400);
  });

  it("rejects verify with an unknown nonce with 400", async () => {
    const dualLinkCache = await activeDualLinkCache([ALICE]);
    const { app } = appWith({ dualLinkCache });

    const res = await verify(app, {
      apolloAccount: ALICE,
      nonce: "never-issued",
      signature: "good-sig",
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({
      error: "invalid or expired nonce",
    });
  });

  it("rejects verify when the account doesn't match who the nonce was issued to", async () => {
    const dualLinkCache = await activeDualLinkCache([ALICE, BOB]);
    const { app } = appWith({ dualLinkCache });

    const c = await challenge(app, ALICE);
    const { nonce } = (await c.json()) as { nonce: string };

    const res = await verify(app, { apolloAccount: BOB, nonce, signature: "good-sig" });
    expect(res.status).toBe(400);
  });

  it("rejects an account that isn't part of an active on-chain dual link with 403", async () => {
    // Cache starts empty and never gets a successful poll for ALICE — fails closed.
    const dualLinkCache = await activeDualLinkCache([]);
    const { app } = appWith({ dualLinkCache });

    const c = await challenge(app, ALICE);
    const { nonce } = (await c.json()) as { nonce: string };

    const res = await verify(app, { apolloAccount: ALICE, nonce, signature: "good-sig" });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toEqual({
      error: "not an active dual link",
    });
  });

  it("rejects a signature that fails apolloVerify with 401", async () => {
    const dualLinkCache = await activeDualLinkCache([ALICE]);
    const { app } = appWith({ dualLinkCache });

    const c = await challenge(app, ALICE);
    const { nonce } = (await c.json()) as { nonce: string };

    const res = await verify(app, { apolloAccount: ALICE, nonce, signature: "wrong-sig" });
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: string }).toEqual({
      error: "signature verification failed",
    });
  });

  it("returns 502 (not an unstructured 500) when the on-chain public-key read throws", async () => {
    const dualLinkCache = await activeDualLinkCache([ALICE]);
    const { app } = appWith({
      dualLinkCache,
      readApolloPublicKey: async () => {
        throw new Error("chain unreachable");
      },
    });

    const c = await challenge(app, ALICE);
    const { nonce } = (await c.json()) as { nonce: string };

    const res = await verify(app, { apolloAccount: ALICE, nonce, signature: "good-sig" });
    expect(res.status).toBe(502);
    expect((await res.json()) as { error: string }).toEqual({
      error: "verification temporarily unavailable",
    });

    // The nonce was already consumed before the throw — a retry with the
    // SAME nonce must fail as "invalid or expired", not re-attempt the read.
    const retry = await verify(app, { apolloAccount: ALICE, nonce, signature: "good-sig" });
    expect(retry.status).toBe(400);
  });

  it("rejects a second verify attempt reusing the same nonce (replay) with 400", async () => {
    const dualLinkCache = await activeDualLinkCache([ALICE]);
    const { app } = appWith({ dualLinkCache });

    const c = await challenge(app, ALICE);
    const { nonce } = (await c.json()) as { nonce: string };

    const first = await verify(app, { apolloAccount: ALICE, nonce, signature: "good-sig" });
    expect(first.status).toBe(200);

    const replay = await verify(app, { apolloAccount: ALICE, nonce, signature: "good-sig" });
    expect(replay.status).toBe(400);
  });
});

describe("connector auth (activation-tracker hook)", () => {
  it("never calls readApolloCounterpart/recordProof for an already-active account, even when both deps are supplied", async () => {
    const dualLinkCache = await activeDualLinkCache([ALICE]);
    const readApolloCounterpart = vi.fn(async () => "should-not-be-called");
    const recordProof = vi.fn();
    const { app } = appWith({
      dualLinkCache,
      readApolloCounterpart,
      pendingActivation: { recordProof },
    });

    const c = await challenge(app, ALICE);
    const { nonce } = (await c.json()) as { nonce: string };
    const v = await verify(app, { apolloAccount: ALICE, nonce, signature: "good-sig" });
    expect(v.status).toBe(200);

    // Give any (wrongly) fired fire-and-forget work a chance to run before
    // asserting it never happened — there's nothing to await deliberately.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readApolloCounterpart).not.toHaveBeenCalled();
    expect(recordProof).not.toHaveBeenCalled();
  });

  it("records a proof pairing for a not-yet-active account whose counterpart resolves, but NEVER issues a secret for it", async () => {
    // Empty active set: ALICE is proven (good signature) but not yet an
    // active dual link — exactly the case this hook exists for. Proving
    // ownership records progress toward activation; it must NOT itself grant
    // a working ephemeral secret (that's the whole point of the gate this
    // hook sits behind — CONFIRMED CRITICAL in review: an earlier version of
    // this test asserted a 200 + secret here, which was the bug).
    const dualLinkCache = await activeDualLinkCache([]);
    const COUNTERPART = apolloAccount(SMART_PREFIX, "alice-counterpart");
    const readApolloCounterpart = vi.fn(async () => COUNTERPART);
    const recordProof = vi.fn();
    const { app } = appWith({
      dualLinkCache,
      readApolloCounterpart,
      pendingActivation: { recordProof },
    });

    const c = await challenge(app, ALICE);
    const { nonce } = (await c.json()) as { nonce: string };
    const v = await verify(app, { apolloAccount: ALICE, nonce, signature: "good-sig" });
    expect(v.status).toBe(202);
    const body = (await v.json()) as { secret?: string; error?: string };
    expect(body.secret).toBeUndefined();
    expect(body.error).toMatch(/not yet an active dual link/);

    await vi.waitFor(() => expect(recordProof).toHaveBeenCalledTimes(1));
    expect(recordProof).toHaveBeenCalledWith(ALICE, COUNTERPART);
  });

  it("doesn't throw out of the handler when readApolloCounterpart rejects, and still never issues a secret for a not-yet-active account", async () => {
    const dualLinkCache = await activeDualLinkCache([]);
    const recordProof = vi.fn();
    const { app } = appWith({
      dualLinkCache,
      readApolloCounterpart: async () => {
        throw new Error("chain unreachable");
      },
      pendingActivation: { recordProof },
    });

    const c = await challenge(app, ALICE);
    const { nonce } = (await c.json()) as { nonce: string };
    const v = await verify(app, { apolloAccount: ALICE, nonce, signature: "good-sig" });
    expect(v.status).toBe(202);
    const body = (await v.json()) as { secret?: string };
    expect(body.secret).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recordProof).not.toHaveBeenCalled();
  });

  it("the verify response is NOT gated on the pairing hook's work — it returns before readApolloCounterpart resolves", async () => {
    // `connectorAuth.ts`'s doc comment on this block requires it be fully
    // fire-and-forget: "do not await it before returning". Every OTHER test
    // in this describe block uses a `readApolloCounterpart` that resolves
    // immediately, so none of them would catch a regression that
    // accidentally `await`ed the block before responding. This test uses a
    // deferred promise that only resolves AFTER the response has already
    // been asserted, proving the response genuinely isn't waiting on it.
    const dualLinkCache = await activeDualLinkCache([]);
    let releaseCounterpartRead: (() => void) | undefined;
    const counterpartRead = new Promise<string | null>((resolve) => {
      releaseCounterpartRead = () => resolve(apolloAccount(SMART_PREFIX, "alice-counterpart"));
    });
    const readApolloCounterpart = vi.fn(() => counterpartRead);
    const recordProof = vi.fn();
    const { app } = appWith({
      dualLinkCache,
      readApolloCounterpart,
      pendingActivation: { recordProof },
    });

    const c = await challenge(app, ALICE);
    const { nonce } = (await c.json()) as { nonce: string };

    // If the handler incorrectly awaited the pairing hook, this call itself
    // would hang until releaseCounterpartRead() below is invoked. It must
    // resolve well before that.
    const v = await verify(app, { apolloAccount: ALICE, nonce, signature: "good-sig" });
    expect(v.status).toBe(202);
    expect(recordProof).not.toHaveBeenCalled(); // the background read hasn't resolved yet

    releaseCounterpartRead!();
    await vi.waitFor(() => expect(recordProof).toHaveBeenCalledTimes(1));
  });

  it("only ONE of the two activation-hook deps supplied (never both) behaves exactly like neither being supplied — still 403s a not-yet-active account", async () => {
    // `canRecordActivationProof` requires BOTH deps (`&&`, not `||`) — a
    // regression that loosened either check could let a not-yet-active
    // account past the 403 gate without ever actually being able to record
    // a proof (since the inner block still requires both).
    const dualLinkCache = await activeDualLinkCache([]);

    const onlyCounterpart = appWith({
      dualLinkCache,
      readApolloCounterpart: vi.fn(async () => "unused"),
      // no pendingActivation
    });
    const c1 = await challenge(onlyCounterpart.app, ALICE);
    const { nonce: nonce1 } = (await c1.json()) as { nonce: string };
    const v1 = await verify(onlyCounterpart.app, { apolloAccount: ALICE, nonce: nonce1, signature: "good-sig" });
    expect(v1.status).toBe(403);

    const onlyTracker = appWith({
      dualLinkCache,
      pendingActivation: { recordProof: vi.fn() },
      // no readApolloCounterpart
    });
    const c2 = await challenge(onlyTracker.app, ALICE);
    const { nonce: nonce2 } = (await c2.json()) as { nonce: string };
    const v2 = await verify(onlyTracker.app, { apolloAccount: ALICE, nonce: nonce2, signature: "good-sig" });
    expect(v2.status).toBe(403);
  });

  it("readApolloCounterpart resolving null (genuinely unlinked) never calls recordProof, and still returns 202 with no secret", async () => {
    const dualLinkCache = await activeDualLinkCache([]);
    const readApolloCounterpart = vi.fn(async () => null);
    const recordProof = vi.fn();
    const { app } = appWith({
      dualLinkCache,
      readApolloCounterpart,
      pendingActivation: { recordProof },
    });

    const c = await challenge(app, ALICE);
    const { nonce } = (await c.json()) as { nonce: string };
    const v = await verify(app, { apolloAccount: ALICE, nonce, signature: "good-sig" });
    expect(v.status).toBe(202);
    const body = (await v.json()) as { secret?: string };
    expect(body.secret).toBeUndefined();

    await vi.waitFor(() => expect(readApolloCounterpart).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recordProof).not.toHaveBeenCalled();
  });
});
