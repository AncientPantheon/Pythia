import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { registerGetConfirmations } from "./getConfirmations.js";
import type { SourceConfig } from "../config/index.js";

const primary: SourceConfig = {
  id: "stoachain-primary",
  url: "https://primary.example",
  role: "primary",
  chain: "stoachain",
};
const fallback: SourceConfig = {
  id: "stoachain-fallback",
  url: "https://fallback.example",
  role: "fallback",
  chain: "stoachain",
};

const TX = "requestkey-abc";

function pollMined(txHeight: number): Response {
  return new Response(
    JSON.stringify({ [TX]: { blockHeight: txHeight } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function cut(chainId: number, height: number): Response {
  return new Response(
    JSON.stringify({ hashes: { [String(chainId)]: { height } } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function fetchFor(txHeight: number, currentHeight: number) {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/cut")) return cut(0, currentHeight);
    return pollMined(txHeight);
  });
}

function appWith(fetchImpl: typeof fetch): Hono {
  const app = new Hono();
  registerGetConfirmations(app, {
    sources: { primary, fallback },
    fetchImpl: fetchImpl as never,
    finalityDepth: 6,
  });
  return app;
}

async function get(app: Hono, query: string): Promise<Response> {
  return app.request(`/api/v1/getConfirmations${query}`);
}

describe("GET /api/v1/getConfirmations", () => {
  it("returns 200 pending for a tx below finalityDepth", async () => {
    // tx 100, current 104 → depth 4 < 6 → pending.
    const res = await get(
      appWith(fetchFor(100, 104) as never),
      `?chain=stoachain&tx=${TX}&chainId=0`,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      chain: "stoachain",
      chainId: 0,
      tx: TX,
      status: "pending",
      depth: 4,
      finalityDepth: 6,
      blockHeight: 100,
    });
  });

  it("returns 200 final for a tx at/above finalityDepth", async () => {
    // depth 6 === finalityDepth → final (inclusive boundary).
    const res = await get(
      appWith(fetchFor(100, 106) as never),
      `?chain=stoachain&tx=${TX}&chainId=0`,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; depth: number };
    expect(body.status).toBe("final");
    expect(body.depth).toBe(6);
  });

  it("rejects an unsupported chain with 400 and issues NO fetch", async () => {
    const fetchImpl = vi.fn(async () => cut(0, 1));

    const res = await get(
      appWith(fetchImpl as never),
      `?chain=btc&tx=${TX}`,
    );

    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toMatch(/chain/i);
    expect(body.code).toBe("pythia_unsupported_chain");
  });

  it("rejects an empty tx with 400 and issues NO fetch", async () => {
    const fetchImpl = vi.fn(async () => cut(0, 1));

    const res = await get(appWith(fetchImpl as never), "?chain=stoachain&tx=");

    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toMatch(/tx/i);
    expect(body.code).toBe("pythia_validation");
  });

  it("maps pool exhaustion to 502 with the per-source failures body", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("all down");
    });

    const res = await get(
      appWith(fetchImpl as never),
      `?chain=stoachain&tx=${TX}&chainId=0`,
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: string;
      code: string;
      failures: { sourceId: string }[];
    };
    expect(body.error).toBe("PythiaPoolExhaustedError");
    expect(body.code).toBe("pythia_pool_exhausted");
    expect(body.failures.map((f) => f.sourceId)).toEqual([
      "stoachain-primary",
      "stoachain-fallback",
    ]);
  });

  it("maps an upstream 4xx (malformed tx) to HTTP 400 with the rejection snippet, NOT a 500", async () => {
    // The exact LIVE crash: a malformed request key made getConfirmations 500
    // with a SyntaxError. It must now be a clean 400 client error carrying the
    // node's plain-text rejection reason.
    const snippet =
      "Error in $.requestKeys[0]: Base64-encoded bytestring has invalid size";
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/cut")) return cut(0, 200);
      return new Response(snippet, {
        status: 400,
        headers: { "content-type": "text/plain" },
      });
    });

    const res = await get(
      appWith(fetchImpl as never),
      `?chain=stoachain&tx=${TX}&chainId=0`,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toContain("upstream rejected request");
    expect(body.error).toContain("invalid size");
    expect(body.code).toBe("pythia_upstream");
  });

  it("maps an upstream 5xx to HTTP 502 upstream error", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/cut")) return cut(0, 200);
      return new Response("node down", { status: 503 });
    });

    const res = await get(
      appWith(fetchImpl as never),
      `?chain=stoachain&tx=${TX}&chainId=0`,
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe("upstream error");
    expect(body.code).toBe("pythia_upstream");
  });
});
