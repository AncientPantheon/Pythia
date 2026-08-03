import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

// Mock the chain read + Apollo verify so the route flow is deterministic/offline.
// `apolloVerify` returns true only for the sentinel "good" signature.
vi.mock("../connectors/verify/readApolloPublicKey.js", () => ({
  readApolloPublicKey: vi.fn(async (_deps: unknown, account: string) => `pub-for-${account}`),
}));
vi.mock("../connectors/verify/apolloVerify.js", () => ({
  apolloVerify: vi.fn(async (sig: string) => sig === "good"),
}));

import { registerConnectorVerify } from "./connectorVerify.js";

const STD = "₱.alpha";
const SMART = "Π.beta";

function appWith(pendingActivation?: {
  recordProof(apolloAccount: string, counterpart: string): void;
  statusOf?(a: string, b: string): "none" | "half" | "ready" | "activated";
}): Hono {
  const app = new Hono();
  // A stub Upload Pool so the trust-anchor read resolves a node; the pubkey read
  // itself is mocked above, so the URL is irrelevant.
  registerConnectorVerify(app, {
    txSenders: { enabledNodes: () => [{ id: "n1", url: "http://n1" }] },
    pendingActivation,
  });
  return app;
}

/** Extract the `pythia_link=<sid>` name=value from a Set-Cookie header. */
function cookieFrom(res: Response): string {
  const sc = res.headers.get("set-cookie") ?? "";
  return sc.split(";")[0];
}

async function start(app: Hono, pair: { standard: string; smart: string }): Promise<Response> {
  return app.request("/api/connectors/verify/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(pair),
  });
}

/** Build the generic `proofs` query value from [account, sig] pairs. */
function proofsQ(pairs: Array<[string, string]>): string {
  return encodeURIComponent(JSON.stringify(pairs.map(([apollo, sig]) => ({ apollo, sig }))));
}

describe("connector verify flow", () => {
  it("rejects a pair that isn't one Standard (₱.) + one Smart (Π.)", async () => {
    const res = await start(appWith(), { standard: STD, smart: STD });
    expect(res.status).toBe(400);
  });

  it("issues a nonce + session cookie, verifies both halves, reports them proven", async () => {
    const app = appWith();
    const s = await start(app, { standard: STD, smart: SMART });
    expect(s.status).toBe(200);
    const { nonce } = (await s.json()) as { nonce: string };
    expect(nonce).toHaveLength(48);
    const cookie = cookieFrom(s);
    expect(cookie).toMatch(/^pythia_link=/);

    const cb = await app.request(
      `/connectors/verify/callback?challenge=${nonce}&proofs=${proofsQ([[STD,"good"],[SMART,"good"]])}`,
      { headers: { cookie }, redirect: "manual" },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/#connectors");

    const status = await app.request("/api/connectors/verify/status", { headers: { cookie } });
    const body = (await status.json()) as { proven: string[] };
    expect(body.proven.sort()).toEqual([STD, SMART].sort());
  });

  it("marks only the half whose signature actually verifies (one of two)", async () => {
    const app = appWith();
    const s = await start(app, { standard: STD, smart: SMART });
    const { nonce } = (await s.json()) as { nonce: string };
    const cookie = cookieFrom(s);

    // Standard signature is bad, Smart is good → only Smart proven.
    await app.request(`/connectors/verify/callback?challenge=${nonce}&proofs=${proofsQ([[STD,"bad"],[SMART,"good"]])}`, {
      headers: { cookie },
      redirect: "manual",
    });
    const status = await app.request("/api/connectors/verify/status", { headers: { cookie } });
    expect(((await status.json()) as { proven: string[] }).proven).toEqual([SMART]);
  });

  it("rejects a forged/planted cookie (no valid HMAC) — proves nothing (fixation)", async () => {
    const app = appWith();
    const s = await start(app, { standard: STD, smart: SMART });
    const { nonce } = (await s.json()) as { nonce: string };

    // An attacker-chosen cookie the server never issued must not be accepted as a
    // session: the callback's good sigs prove nothing under it, and /status is empty.
    await app.request(`/connectors/verify/callback?challenge=${nonce}&proofs=${proofsQ([[STD,"good"],[SMART,"good"]])}`, {
      headers: { cookie: "pythia_link=attacker-chosen.badmac" },
      redirect: "manual",
    });
    const status = await app.request("/api/connectors/verify/status", {
      headers: { cookie: "pythia_link=attacker-chosen.badmac" },
    });
    expect(((await status.json()) as { proven: string[] }).proven).toEqual([]);
  });

  it("bridges a fully-proven pair into the activation tracker (both directions)", async () => {
    const recordProof = vi.fn();
    const app = appWith({ recordProof });
    const s = await start(app, { standard: STD, smart: SMART });
    const { nonce } = (await s.json()) as { nonce: string };
    const cookie = cookieFrom(s);

    await app.request(
      `/connectors/verify/callback?challenge=${nonce}&proofs=${proofsQ([[STD,"good"],[SMART,"good"]])}`,
      { headers: { cookie }, redirect: "manual" },
    );

    // Both halves proven → the pair is queued for autonomous A_LinkDualApiKey,
    // recorded once per direction (each half is the other's counterpart).
    expect(recordProof).toHaveBeenCalledWith(STD, SMART);
    expect(recordProof).toHaveBeenCalledWith(SMART, STD);
    expect(recordProof).toHaveBeenCalledTimes(2);
  });

  it("reports the autonomous activation phase for the watched pair via /status", async () => {
    // Tracker says the pair is still queued/in-flight → "activating".
    const recordProof = vi.fn();
    const app = appWith({ recordProof, statusOf: () => "ready" });
    const s = await start(app, { standard: STD, smart: SMART });
    const { nonce } = (await s.json()) as { nonce: string };
    const cookie = cookieFrom(s);
    await app.request(
      `/connectors/verify/callback?challenge=${nonce}&proofs=${proofsQ([[STD,"good"],[SMART,"good"]])}`,
      { headers: { cookie }, redirect: "manual" },
    );
    const q = `standard=${encodeURIComponent(STD)}&smart=${encodeURIComponent(SMART)}`;
    const st = await app.request(`/api/connectors/verify/status?${q}`, { headers: { cookie } });
    expect(((await st.json()) as { activation?: string }).activation).toBe("activating");
  });

  it("reports 'activated' when the tracker confirms the pair activated on-chain", async () => {
    // statusOf "activated" ⇒ commitActivation fired for this exact pair → "activated".
    const app = appWith({ recordProof: vi.fn(), statusOf: () => "activated" });
    const s = await start(app, { standard: STD, smart: SMART });
    const { nonce } = (await s.json()) as { nonce: string };
    const cookie = cookieFrom(s);
    await app.request(
      `/connectors/verify/callback?challenge=${nonce}&proofs=${proofsQ([[STD,"good"],[SMART,"good"]])}`,
      { headers: { cookie }, redirect: "manual" },
    );
    const q = `standard=${encodeURIComponent(STD)}&smart=${encodeURIComponent(SMART)}`;
    const st = await app.request(`/api/connectors/verify/status?${q}`, { headers: { cookie } });
    expect(((await st.json()) as { activation?: string }).activation).toBe("activated");
  });

  it("does NOT infer 'activated' from per-account proof — a never-recorded pair reports 'pending'", async () => {
    // BOTH halves are proven in this session, but the tracker never recorded this
    // pair (statusOf "none") — e.g. a cross-pair the operator never verified together.
    // It must NOT be reported as activated (the MED review finding).
    const app = appWith({ recordProof: vi.fn(), statusOf: () => "none" });
    const s = await start(app, { standard: STD, smart: SMART });
    const { nonce } = (await s.json()) as { nonce: string };
    const cookie = cookieFrom(s);
    await app.request(
      `/connectors/verify/callback?challenge=${nonce}&proofs=${proofsQ([[STD,"good"],[SMART,"good"]])}`,
      { headers: { cookie }, redirect: "manual" },
    );
    const q = `standard=${encodeURIComponent(STD)}&smart=${encodeURIComponent(SMART)}`;
    const st = await app.request(`/api/connectors/verify/status?${q}`, { headers: { cookie } });
    expect(((await st.json()) as { activation?: string }).activation).toBe("pending");
  });

  it("omits activation entirely when no pair is passed to /status", async () => {
    const app = appWith({ recordProof: vi.fn(), statusOf: () => "ready" });
    const s = await start(app, { standard: STD, smart: SMART });
    const cookie = cookieFrom(s);
    const st = await app.request("/api/connectors/verify/status", { headers: { cookie } });
    expect((await st.json()) as { activation?: string }).not.toHaveProperty("activation");
  });

  it("does NOT bridge to activation when only one half proves ownership", async () => {
    const recordProof = vi.fn();
    const app = appWith({ recordProof });
    const s = await start(app, { standard: STD, smart: SMART });
    const { nonce } = (await s.json()) as { nonce: string };
    const cookie = cookieFrom(s);

    // Only Smart verifies (Standard sig is bad) → pair is incomplete, no activation.
    await app.request(
      `/connectors/verify/callback?challenge=${nonce}&proofs=${proofsQ([[STD,"bad"],[SMART,"good"]])}`,
      { headers: { cookie }, redirect: "manual" },
    );
    expect(recordProof).not.toHaveBeenCalled();
  });

  it("a replayed callback (same nonce + sig) doesn't re-prove — consume is single-use", async () => {
    const app = appWith();
    const s = await start(app, { standard: STD, smart: SMART });
    const { nonce } = (await s.json()) as { nonce: string };
    const cookie = cookieFrom(s);

    const callback = () =>
      app.request(`/connectors/verify/callback?challenge=${nonce}&proofs=${proofsQ([[STD,"good"],[SMART,"good"]])}`, {
        headers: { cookie },
        redirect: "manual",
      });
    await callback();
    await callback(); // replay of the same nonce + signatures

    const status = await app.request("/api/connectors/verify/status", { headers: { cookie } });
    const proven = ((await status.json()) as { proven: string[] }).proven;
    // Still exactly the two halves, once each — replay is a no-op, no duplication.
    expect(proven.sort()).toEqual([STD, SMART].sort());
  });
});
