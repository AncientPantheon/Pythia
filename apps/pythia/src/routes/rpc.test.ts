import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { registerRpc } from "./rpc.js";
import type { SourceConfig } from "../config/index.js";

const primary: SourceConfig = {
  id: "stoachain-primary",
  url: "https://primary.example",
  role: "primary",
  chain: "stoa",
};
const fallback: SourceConfig = {
  id: "stoachain-fallback",
  url: "https://fallback.example",
  role: "fallback",
  chain: "stoa",
};

function appWith(fetchImpl: typeof fetch): Hono {
  const app = new Hono();
  registerRpc(app, {
    sources: { primary, fallback },
    fetchImpl: fetchImpl as never,
  });
  return app;
}

function nodeOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function post(app: Hono, body: unknown): Promise<Response> {
  return app.request("/stoachain/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const CALLER_PAYLOAD = {
  exec: { code: "(coin.get-balance \"alice\")", data: {} },
  meta: { chainId: "0", sender: "alice" },
  signers: [{ pubKey: "abc", sig: "caller-own-sig" }],
};

describe("POST /stoachain/rpc verbatim relay", () => {
  it("forwards the payload BYTE-IDENTICAL to the node — no added key/sig/field", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return nodeOk({ result: "ok" });
    });

    const res = await post(appWith(fetchImpl as never), {
      chainId: 0,
      payload: CALLER_PAYLOAD,
    });

    expect(res.status).toBe(200);
    // The body the node received deep-equals the caller's payload exactly —
    // Pythia neither reshaped it nor injected any key material.
    expect(JSON.parse(capturedBody!)).toEqual(CALLER_PAYLOAD);
    // And no signature was produced/augmented by Pythia beyond the caller's own.
    expect(JSON.parse(capturedBody!).signers).toEqual(CALLER_PAYLOAD.signers);
  });

  it("targets the correct per-chain read path for the caller-named chain", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = vi.fn(async (url: string) => {
      capturedUrl = url;
      return nodeOk({ ok: true });
    });

    await post(appWith(fetchImpl as never), { chainId: 5, payload: CALLER_PAYLOAD });

    expect(capturedUrl).toBe(
      "https://primary.example/chainweb/0.0/stoa/chain/5/pact/api/v1/local",
    );
  });

  it("defaults to chain 0 when chainId is absent", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = vi.fn(async (url: string) => {
      capturedUrl = url;
      return nodeOk({ ok: true });
    });

    await post(appWith(fetchImpl as never), { payload: CALLER_PAYLOAD });

    expect(capturedUrl).toBe(
      "https://primary.example/chainweb/0.0/stoa/chain/0/pact/api/v1/local",
    );
  });

  it("rejects a non-object body with a self-identifying 400 (code pythia_validation)", async () => {
    // Pythia's OWN bad-body 400 carries the discriminator so the SDK remaps it,
    // distinct from a node-arrived 400 which has no `code`.
    const fetchImpl = vi.fn(async () => nodeOk({}));
    const res = await post(appWith(fetchImpl as never), null);

    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("pythia_validation");
  });

  it("rejects an out-of-range chainId with HTTP 400 and issues NO fetch", async () => {
    const fetchImpl = vi.fn(async () => nodeOk({}));

    const res = await post(appWith(fetchImpl as never), {
      chainId: 99,
      payload: CALLER_PAYLOAD,
    });

    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toMatch(/chainId/i);
    expect(body.code).toBe("pythia_validation");
  });

  it("fails over to the fallback on a primary transport error and still forwards verbatim", async () => {
    let fallbackBody: string | undefined;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://primary.example")) throw new TypeError("down");
      fallbackBody = init?.body as string;
      return nodeOk({ from: "fallback" });
    });

    const res = await post(appWith(fetchImpl as never), {
      chainId: 1,
      payload: CALLER_PAYLOAD,
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ from: "fallback" });
    expect(JSON.parse(fallbackBody!)).toEqual(CALLER_PAYLOAD);
  });

  it("rejects an over-limit body with HTTP 413 and issues NO fetch", async () => {
    // A relayed /local command is small; an oversized body is a DoS vector and
    // must be capped before it is read or forwarded to any node.
    const fetchImpl = vi.fn(async () => nodeOk({}));
    const app = appWith(fetchImpl as never);

    // ~2 MB payload, over the 1 MB cap.
    const huge = "x".repeat(2 * 1024 * 1024);
    const res = await app.request("/stoachain/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chainId: 0, payload: { blob: huge } }),
    });

    expect(res.status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still forwards a normal small relay body under the limit", async () => {
    // The cap must not disturb ordinary traffic — a small signed command still
    // relays and returns the node body verbatim.
    let capturedBody: string | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return nodeOk({ result: "ok" });
    });

    const res = await post(appWith(fetchImpl as never), {
      chainId: 0,
      payload: CALLER_PAYLOAD,
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(capturedBody!)).toEqual(CALLER_PAYLOAD);
  });

  it("surfaces pool exhaustion as a 502 carrying both per-source failures", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("all down");
    });

    const res = await post(appWith(fetchImpl as never), {
      chainId: 2,
      payload: CALLER_PAYLOAD,
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: string;
      code: string;
      chainId: number;
      failures: { sourceId: string }[];
    };
    expect(body.error).toBe("PythiaPoolExhaustedError");
    expect(body.code).toBe("pythia_pool_exhausted");
    expect(body.failures.map((f: { sourceId: string }) => f.sourceId)).toEqual([
      "stoachain-primary",
      "stoachain-fallback",
    ]);
    expect(body.chainId).toBe(2);
  });
});
