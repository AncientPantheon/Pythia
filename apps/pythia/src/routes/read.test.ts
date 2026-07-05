import { describe, it, expect, vi } from "vitest";
import { blake2b } from "@noble/hashes/blake2b";
import { Hono } from "hono";
import { registerRead } from "./read.js";
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
  registerRead(app, {
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
  return app.request("/stoachain/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Independently recompute the node's hash rule. */
function expectedHash(cmd: string): string {
  return Buffer.from(blake2b(new TextEncoder().encode(cmd), { dkLen: 32 }))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("POST /stoachain/read dirty read", () => {
  it("relays a valid {cmd,hash,sigs} /local command whose hash matches blake2b(cmd)", async () => {
    // The node verifies hash == blake2b(cmd); the route must build a command that
    // survives that check, else every read would be rejected by the node.
    let capturedBody: string | undefined;
    let capturedUrl: string | undefined;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = init?.body as string;
      return nodeOk({ result: { status: "success", data: 3 } });
    });

    const res = await post(appWith(fetchImpl as never), {
      chainId: 0,
      code: "(+ 1 2)",
    });

    expect(res.status).toBe(200);
    expect(capturedUrl).toBe(
      "https://primary.example/chainweb/0.0/stoa/chain/0/pact/api/v1/local",
    );
    const envelope = JSON.parse(capturedBody!) as {
      cmd: string;
      hash: string;
      sigs: unknown[];
    };
    expect(envelope.hash).toBe(expectedHash(envelope.cmd));
    expect(envelope.sigs).toEqual([]);
    const cmd = JSON.parse(envelope.cmd) as {
      payload: { exec: { code: string } };
    };
    expect(cmd.payload.exec.code).toBe("(+ 1 2)");
  });

  it("returns the node's response VERBATIM — a keys-required failure passes through unchanged", async () => {
    // A read that needs caps/keys comes back as the node's failure envelope; that
    // failure IS the useful output and must reach the caller undecoded.
    const nodeFailure = {
      result: { status: "failure", error: { message: "Keyset failure" } },
    };
    const fetchImpl = vi.fn(async () => nodeOk(nodeFailure));

    const res = await post(appWith(fetchImpl as never), { code: "(protected)" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(nodeFailure);
  });

  it("defaults to chain 0 when chainId is omitted", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = vi.fn(async (url: string) => {
      capturedUrl = url;
      return nodeOk({ ok: true });
    });

    await post(appWith(fetchImpl as never), { code: "(f)" });

    expect(capturedUrl).toBe(
      "https://primary.example/chainweb/0.0/stoa/chain/0/pact/api/v1/local",
    );
  });

  it("carries the caller's data + sender into the built command", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return nodeOk({ ok: true });
    });

    await post(appWith(fetchImpl as never), {
      chainId: 1,
      code: "(read)",
      data: { acct: "k:z" },
      sender: "k:sender",
    });

    const cmd = JSON.parse(
      (JSON.parse(capturedBody!) as { cmd: string }).cmd,
    ) as { payload: { exec: { data: unknown } }; meta: { sender: string } };
    expect(cmd.payload.exec.data).toEqual({ acct: "k:z" });
    expect(cmd.meta.sender).toBe("k:sender");
  });

  it("rejects a missing code with a self-identifying 400 (pythia_validation) and NO fetch", async () => {
    const fetchImpl = vi.fn(async () => nodeOk({}));

    const res = await post(appWith(fetchImpl as never), { chainId: 0 });

    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("pythia_validation");
    expect(body.error).toMatch(/code/i);
  });

  it("rejects an empty-string code with a 400 and NO fetch", async () => {
    const fetchImpl = vi.fn(async () => nodeOk({}));

    const res = await post(appWith(fetchImpl as never), { code: "   " });

    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range chainId with a 400 and NO fetch", async () => {
    const fetchImpl = vi.fn(async () => nodeOk({}));

    const res = await post(appWith(fetchImpl as never), {
      chainId: 99,
      code: "(f)",
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
      chainId: 2,
      code: "(f)",
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      code: string;
      chainId: number;
      failures: { sourceId: string }[];
    };
    expect(body.code).toBe("pythia_pool_exhausted");
    expect(body.failures.map((f) => f.sourceId)).toEqual([
      "stoachain-primary",
      "stoachain-fallback",
    ]);
    expect(body.chainId).toBe(2);
  });

  it("rejects an over-limit body with HTTP 413 and NO fetch", async () => {
    const fetchImpl = vi.fn(async () => nodeOk({}));
    const app = appWith(fetchImpl as never);

    const huge = "x".repeat(2 * 1024 * 1024);
    const res = await app.request("/stoachain/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "(f)", data: { blob: huge } }),
    });

    expect(res.status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
