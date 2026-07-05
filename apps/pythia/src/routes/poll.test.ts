import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { registerPoll } from "./poll.js";
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

const KEY_A = "reqkey-a";
const KEY_B = "reqkey-b";
const FINALITY = 6;

function appWith(fetchImpl: typeof fetch): Hono {
  const app = new Hono();
  registerPoll(app, {
    sources: { primary, fallback },
    fetchImpl: fetchImpl as never,
    finalityDepth: FINALITY,
  });
  return app;
}

/** A poll response keying each mined key to its inclusion height. */
function poll(records: Record<string, number>): Response {
  const body: Record<string, unknown> = {};
  for (const [key, blockHeight] of Object.entries(records)) {
    body[key] = { reqKey: key, result: { status: "success" }, blockHeight };
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function cut(chainId: number, height: number): Response {
  return new Response(
    JSON.stringify({ hashes: { [String(chainId)]: { height, hash: "h" } } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function fetchFor(pollRes: Response, cutRes: Response) {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/cut")) return cutRes.clone();
    return pollRes.clone();
  });
}

async function post(app: Hono, body: unknown): Promise<Response> {
  return app.request("/stoachain/poll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /stoachain/poll tx status", () => {
  it("returns per-key status+depth keyed by request key at finalityDepth", async () => {
    // KEY_A mined at 100 (depth 6 → final), KEY_B at 104 (depth 2 → pending).
    const fetchImpl = fetchFor(poll({ [KEY_A]: 100, [KEY_B]: 104 }), cut(0, 106));

    const res = await post(appWith(fetchImpl as never), {
      chainId: 0,
      requestKeys: [KEY_A, KEY_B],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chainId: number;
      finalityDepth: number;
      results: Record<string, { status: string; depth: number; blockHeight?: number }>;
    };
    expect(body.chainId).toBe(0);
    expect(body.finalityDepth).toBe(FINALITY);
    expect(body.results[KEY_A]).toEqual({ status: "final", depth: 6, blockHeight: 100 });
    expect(body.results[KEY_B]).toEqual({ status: "pending", depth: 2, blockHeight: 104 });
  });

  it("reports pending/0 for an unmined key", async () => {
    const fetchImpl = fetchFor(poll({ [KEY_B]: 100 }), cut(0, 200));

    const res = await post(appWith(fetchImpl as never), {
      requestKeys: [KEY_A, KEY_B],
    });

    const body = (await res.json()) as {
      results: Record<string, { status: string; depth: number }>;
    };
    expect(body.results[KEY_A]).toEqual({ status: "pending", depth: 0 });
  });

  it("rejects a missing requestKeys array with a 400 (pythia_validation) and NO fetch", async () => {
    const fetchImpl = vi.fn(async () => cut(0, 1));

    const res = await post(appWith(fetchImpl as never), { chainId: 0 });

    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("pythia_validation");
  });

  it("rejects an empty requestKeys array with a 400 and NO fetch", async () => {
    const fetchImpl = vi.fn(async () => cut(0, 1));

    const res = await post(appWith(fetchImpl as never), { requestKeys: [] });

    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range chainId with a 400 and NO fetch", async () => {
    const fetchImpl = vi.fn(async () => cut(0, 1));

    const res = await post(appWith(fetchImpl as never), {
      chainId: 99,
      requestKeys: [KEY_A],
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
      requestKeys: [KEY_A],
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      code: string;
      chainId: number;
      failures: { sourceId: string }[];
    };
    expect(body.code).toBe("pythia_pool_exhausted");
    expect(body.chainId).toBe(2);
    expect(body.failures.map((f) => f.sourceId)).toEqual([
      "stoachain-primary",
      "stoachain-fallback",
    ]);
  });

  it("maps a poll upstream 4xx to a client 400 (upstream envelope)", async () => {
    // A malformed request key makes the node answer 400 plain-text; the route
    // surfaces it as an upstream-rejected 400, never a raw 500.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/cut")) return cut(0, 200);
      return new Response("bad request key", {
        status: 400,
        headers: { "content-type": "text/plain" },
      });
    });

    const res = await post(appWith(fetchImpl as never), {
      requestKeys: [KEY_A],
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("pythia_upstream");
  });
});
