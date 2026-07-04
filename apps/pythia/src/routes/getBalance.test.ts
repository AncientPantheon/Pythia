import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { registerGetBalance } from "./getBalance.js";
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

function localOk(decimal: string): Response {
  return new Response(
    JSON.stringify({ result: { status: "success", data: { decimal } } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function supplyByExpression(bodyText: string): string {
  if (bodyText.includes("DALOS.UR_DISPOSupply")) return "12.5";
  if (bodyText.includes("TFT.URC_VirtualOuro")) return "3.25";
  if (bodyText.includes("GAS-8Nh-JO8JO4F5")) return "0.001";
  return "777.7";
}

function appWith(fetchImpl: typeof fetch): Hono {
  const app = new Hono();
  registerGetBalance(app, {
    sources: { primary, fallback },
    fetchImpl: fetchImpl as never,
  });
  return app;
}

async function get(app: Hono, query: string): Promise<Response> {
  return app.request(`/api/v1/getBalance${query}`);
}

describe("GET /api/v1/getBalance", () => {
  it("returns 200 with the composite balance for a valid request", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      localOk(supplyByExpression(String(init?.body))),
    );

    const res = await get(
      appWith(fetchImpl as never),
      "?chain=stoachain&address=k:abc",
    );

    expect(res.status).toBe(200);
    // The route returns the T3.2 composite verbatim, each field the decoded
    // supply for its Pact expression.
    await expect(res.json()).resolves.toEqual({
      chain: "stoachain",
      address: "k:abc",
      ignis: "0.001",
      ouroDispo: "12.5",
      virtualOuro: "3.25",
    });
  });

  it("includes the optional token supply when a token id is supplied", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      localOk(supplyByExpression(String(init?.body))),
    );

    const res = await get(
      appWith(fetchImpl as never),
      "?chain=stoachain&address=k:abc&token=AURYN-8Nh-JO8JO4F5",
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { token?: { id: string; supply: string } };
    expect(body.token).toEqual({ id: "AURYN-8Nh-JO8JO4F5", supply: "777.7" });
  });

  it("treats an empty ?token= as absent: no token block, only the 3 base reads", async () => {
    // `?token=` yields "" — an empty token must NOT trigger a 4th supply read
    // nor a bogus token:{id:""} field; it is equivalent to omitting the param.
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      localOk(supplyByExpression(String(init?.body))),
    );

    const res = await get(
      appWith(fetchImpl as never),
      "?chain=stoachain&address=k:abc&token=",
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("token");
    // Exactly the three base supply reads occurred — no extra token read.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("rejects an unsupported chain with 400 and issues NO fetch", async () => {
    // chain=kadena must be rejected as unsupported before any node read — the
    // typed error maps to a 400, not a 502.
    const fetchImpl = vi.fn(async () => localOk("1"));

    const res = await get(
      appWith(fetchImpl as never),
      "?chain=kadena&address=k:abc",
    );

    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toMatch(/chain/i);
    // The envelope self-identifies so the SDK maps it without message-sniffing.
    expect(body.code).toBe("pythia_unsupported_chain");
  });

  it("rejects an empty address with 400 and issues NO fetch", async () => {
    const fetchImpl = vi.fn(async () => localOk("1"));

    const res = await get(
      appWith(fetchImpl as never),
      "?chain=stoachain&address=",
    );

    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toMatch(/address/i);
    expect(body.code).toBe("pythia_validation");
  });

  it("rejects an address containing a Pact-breaking quote with 400 and issues NO fetch", async () => {
    // An address with `"` could close the Pact string literal and inject
    // arbitrary read-only Pact; it must be rejected before any node read.
    const fetchImpl = vi.fn(async () => localOk("1"));

    const res = await get(
      appWith(fetchImpl as never),
      `?chain=stoachain&address=${encodeURIComponent('k:a" (something)')}`,
    );

    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/address/i);
  });

  it("rejects a token id containing injection chars with 400 and issues NO fetch", async () => {
    // The optional token id is interpolated into a Pact literal too, so a
    // backslash/paren in it is the same break-out vector and must 400.
    const fetchImpl = vi.fn(async () => localOk("1"));

    const res = await get(
      appWith(fetchImpl as never),
      `?chain=stoachain&address=k:abc&token=${encodeURIComponent("BAD\\(x)")}`,
    );

    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toMatch(/token/i);
    expect(body.code).toBe("pythia_validation");
  });

  it("maps pool exhaustion to 502 with the per-source failures body", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("all down");
    });

    const res = await get(
      appWith(fetchImpl as never),
      "?chain=stoachain&address=k:abc",
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

  it("maps an upstream 4xx (node-rejected address) to HTTP 400 with the rejection snippet", async () => {
    // A node 400 + plain text must become a clean 400 client error, never a 500
    // SyntaxError from parsing a non-JSON body.
    const fetchImpl = vi.fn(async () =>
      new Response("Error: invalid account format", {
        status: 400,
        headers: { "content-type": "text/plain" },
      }),
    );

    const res = await get(
      appWith(fetchImpl as never),
      "?chain=stoachain&address=k:abc",
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toContain("upstream rejected request");
    expect(body.error).toContain("invalid account format");
    expect(body.code).toBe("pythia_upstream");
  });

  it("maps an upstream 5xx to HTTP 502 upstream error", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("backend unavailable", { status: 500 }),
    );

    const res = await get(
      appWith(fetchImpl as never),
      "?chain=stoachain&address=k:abc",
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe("upstream error");
    expect(body.code).toBe("pythia_upstream");
  });

  it("maps a non-JSON 200 upstream body to HTTP 502 upstream error", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("<html>proxy</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const res = await get(
      appWith(fetchImpl as never),
      "?chain=stoachain&address=k:abc",
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("upstream error");
  });
});
