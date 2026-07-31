import { describe, it, expect, vi } from "vitest";
import { PythiaConnector, type ApolloSigner } from "./connector.js";
import { PythiaClient } from "./client.js";

const BASE = "https://fake";
const ACCOUNT = "₱.test";

/** Build a JSON Response with a given status. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A fetchImpl that routes canned responses by URL pathname and records every
 * call for spy assertions — mirrors the `routedFetch` helper in
 * connector.test.ts, extended here to also serve `/stoachain/read` so ONE
 * shared stub can back both the connector's auth round trip and the client's
 * read call, proving they actually cooperate over the same transport.
 */
function routedFetch(routes: Record<string, () => Response>) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ path, init });
    const route = routes[path];
    if (!route) throw new Error(`no stub route for ${path}`);
    return route();
  });
  return { fetchImpl, calls };
}

/** A signer stub that always succeeds with a fixed signature — no real
 * cryptography needed since this suite proves wiring, not crypto. */
const fakeSigner: ApolloSigner = {
  sign: vi.fn(async () => ({ signature: "fake-sig" })),
};

const FAR_FUTURE = Date.now() + 24 * 60 * 60 * 1000;

function buildStubs() {
  const challenge = vi.fn(() =>
    jsonResponse({
      nonce: "n1",
      rp: "pythia.ancientholdings.eu",
      expiresAt: Date.now() + 60_000,
    }),
  );
  const verify = vi.fn(() =>
    jsonResponse({ secret: "sec-abc", expiresAt: FAR_FUTURE }),
  );
  const read = vi.fn(() =>
    jsonResponse({ result: { status: "success", data: "ok" } }),
  );
  const { fetchImpl, calls } = routedFetch({
    "/connectors/auth/challenge": challenge,
    "/connectors/auth/verify": verify,
    "/stoachain/read": read,
  });
  return { fetchImpl, calls, challenge, verify, read };
}

describe("PythiaConnector + PythiaClient integration", () => {
  it("a client.read() call transparently drives the full connector round trip and attaches x-pythia-key to the read request", async () => {
    // Proves PythiaClientOptions.pythiaKey (T4) actually reaches a REAL
    // PythiaConnector's keyProvider() (T3) end to end: a plain client.read()
    // call, with no direct connector interaction, must trigger challenge +
    // verify AND stamp the resulting secret onto the /stoachain/read request
    // — not just that each piece works in isolation.
    const { fetchImpl, calls } = buildStubs();
    const connector = new PythiaConnector({
      baseUrl: BASE,
      apolloAccount: ACCOUNT,
      signer: fakeSigner,
      fetchImpl: fetchImpl as never,
    });
    const client = new PythiaClient({
      baseUrl: BASE,
      fetchImpl: fetchImpl as never,
      pythiaKey: connector.keyProvider(),
    });

    await client.read({ code: "(+ 1 1)" });

    const paths = calls.map((c) => c.path);
    expect(paths).toContain("/connectors/auth/challenge");
    expect(paths).toContain("/connectors/auth/verify");

    const readCall = calls.find((c) => c.path === "/stoachain/read");
    expect(readCall).toBeDefined();
    const headers = readCall?.init?.headers as Record<string, string>;
    expect(headers["x-pythia-key"]).toBe("sec-abc");
  });

  it("a second client.read() call reuses the connector's cached secret with no repeated auth round trip, and still carries the same header", async () => {
    // The connector's cache (proven in isolation by connector.test.ts) must
    // also hold up through the client's per-request key resolution: a second
    // read must NOT re-trigger challenge/verify, and the header must remain
    // the exact secret from the first (and only) verify response.
    const { fetchImpl, calls, challenge, verify, read } = buildStubs();
    const connector = new PythiaConnector({
      baseUrl: BASE,
      apolloAccount: ACCOUNT,
      signer: fakeSigner,
      fetchImpl: fetchImpl as never,
    });
    const client = new PythiaClient({
      baseUrl: BASE,
      fetchImpl: fetchImpl as never,
      pythiaKey: connector.keyProvider(),
    });

    await client.read({ code: "(+ 1 1)" });
    expect(challenge).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);

    await client.read({ code: "(+ 2 2)" });

    expect(challenge).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);

    const readCalls = calls.filter((c) => c.path === "/stoachain/read");
    expect(readCalls).toHaveLength(2);
    for (const call of readCalls) {
      const headers = call.init?.headers as Record<string, string>;
      expect(headers["x-pythia-key"]).toBe("sec-abc");
    }
  });
});
