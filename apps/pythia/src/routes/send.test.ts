import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { registerSend } from "./send.js";
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
  // The Upload Pool is [primary, fallback] here — tried in order (sequential).
  registerSend(app, {
    senders: [primary, fallback],
    fetchImpl: fetchImpl as never,
  });
  return app;
}

function nodeOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function post(app: Hono, body: unknown): Promise<Response> {
  return app.request("/stoachain/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A caller-SIGNED command as it would appear in the chainweb /send cmds array. */
const SIGNED_CMD = {
  cmd: '{"payload":{}}',
  hash: "abc",
  sigs: [{ sig: "caller-own-signature" }],
};

describe("POST /stoachain/send keyless broadcast", () => {
  it("relays {cmds} VERBATIM to the node /send path — no added key/sig/field", async () => {
    // Keyless: Pythia forwards the caller-signed cmds byte-for-byte to /send and
    // adds nothing. The URL must end /send and the body must be exactly {cmds}.
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    let capturedMethod: string | undefined;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = init?.body as string;
      capturedMethod = init?.method;
      return nodeOk({ requestKeys: ["rk-1"] });
    });

    const res = await post(appWith(fetchImpl as never), {
      chainId: 0,
      cmds: [SIGNED_CMD],
    });

    expect(res.status).toBe(200);
    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toBe(
      "https://primary.example/chainweb/0.0/stoa/chain/0/pact/api/v1/send",
    );
    expect(capturedUrl!.endsWith("/send")).toBe(true);
    expect(JSON.parse(capturedBody!)).toEqual({ cmds: [SIGNED_CMD] });
    // The caller's own signature is untouched — Pythia signed nothing.
    expect(JSON.parse(capturedBody!).cmds[0].sigs).toEqual(SIGNED_CMD.sigs);
  });

  it("returns the node's /send response verbatim", async () => {
    const nodeBody = { requestKeys: ["rk-abc"] };
    const fetchImpl = vi.fn(async () => nodeOk(nodeBody));

    const res = await post(appWith(fetchImpl as never), {
      cmds: [SIGNED_CMD],
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(nodeBody);
  });

  it("passes a node-arrived HTTP error body through verbatim (not remapped)", async () => {
    // A node /send validation 400 is the node's own payload; the keyless relay
    // returns it unchanged rather than wrapping it in a Pythia envelope.
    const nodeErr = { error: "Validation failed" };
    const fetchImpl = vi.fn(async () => nodeOk(nodeErr, 400));

    const res = await post(appWith(fetchImpl as never), { cmds: [SIGNED_CMD] });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual(nodeErr);
  });

  it("defaults to chain 0 when chainId is omitted", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = vi.fn(async (url: string) => {
      capturedUrl = url;
      return nodeOk({ requestKeys: [] });
    });

    await post(appWith(fetchImpl as never), { cmds: [SIGNED_CMD] });

    expect(capturedUrl).toBe(
      "https://primary.example/chainweb/0.0/stoa/chain/0/pact/api/v1/send",
    );
  });

  it("rejects a missing cmds array with a 400 (pythia_validation) and NO fetch", async () => {
    const fetchImpl = vi.fn(async () => nodeOk({}));

    const res = await post(appWith(fetchImpl as never), { chainId: 0 });

    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("pythia_validation");
  });

  it("rejects an empty cmds array with a 400 and NO fetch", async () => {
    const fetchImpl = vi.fn(async () => nodeOk({}));

    const res = await post(appWith(fetchImpl as never), { cmds: [] });

    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range chainId with a 400 and NO fetch", async () => {
    const fetchImpl = vi.fn(async () => nodeOk({}));

    const res = await post(appWith(fetchImpl as never), {
      chainId: 99,
      cmds: [SIGNED_CMD],
    });

    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("pythia_validation");
  });

  it("surfaces pool exhaustion as a 502 carrying both per-source failures", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("all down");
    });

    const res = await post(appWith(fetchImpl as never), {
      chainId: 3,
      cmds: [SIGNED_CMD],
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      code: string;
      chainId: number;
      failures: { sourceId: string }[];
    };
    expect(body.code).toBe("pythia_pool_exhausted");
    expect(body.chainId).toBe(3);
    expect(body.failures.map((f) => f.sourceId)).toEqual([
      "stoachain-primary",
      "stoachain-fallback",
    ]);
  });

  it("returns 503 when the Upload Pool is empty — a signed tx is NEVER routed to a read/seed node", async () => {
    const fetchImpl = vi.fn(async () => nodeOk({}));
    const app = new Hono();
    registerSend(app, { senders: [], fetchImpl: fetchImpl as never });

    const res = await post(app, { cmds: [SIGNED_CMD] });

    expect(res.status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("pythia_no_tx_sender");
  });

  it("rejects an over-limit body with HTTP 413 and NO fetch", async () => {
    const fetchImpl = vi.fn(async () => nodeOk({}));
    const app = appWith(fetchImpl as never);

    const huge = "x".repeat(2 * 1024 * 1024);
    const res = await app.request("/stoachain/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmds: [{ cmd: huge }] }),
    });

    expect(res.status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
