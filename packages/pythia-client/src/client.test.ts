import { describe, it, expect, vi } from "vitest";
import { PythiaClient } from "./client.js";
import {
  PythiaValidationError,
  PythiaUnsupportedChainError,
  PythiaPoolExhaustedError,
} from "./errors.js";

const BASE = "https://pythia.example";

/** Build a JSON Response with a given status. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetchImpl that captures its calls and returns a canned response. */
function stubFetch(response: Response | (() => Response)) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return typeof response === "function" ? response() : response;
  });
  return { fetchImpl, calls };
}

describe("PythiaClient.getBalance", () => {
  it("issues GET /api/v1/getBalance with client-set chain=stoachain and address, returning a typed Balance", async () => {
    const balance = {
      chain: "stoachain",
      address: "k:abc",
      ignis: "0.001",
      ouroDispo: "12.5",
      virtualOuro: "3.25",
    };
    const { fetchImpl, calls } = stubFetch(jsonResponse(balance));
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    const result = await client.getBalance({ address: "k:abc" });

    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe(`${BASE}/api/v1/getBalance`);
    expect(url.searchParams.get("chain")).toBe("stoachain");
    expect(url.searchParams.get("address")).toBe("k:abc");
    // No token query param when the caller did not pass one.
    expect(url.searchParams.has("token")).toBe(false);
    expect(calls[0].init?.method ?? "GET").toBe("GET");
    expect(result).toEqual(balance);
  });

  it("appends token to the query only when the caller provides it", async () => {
    const { fetchImpl, calls } = stubFetch(
      jsonResponse({
        chain: "stoachain",
        address: "k:abc",
        ignis: "0",
        ouroDispo: "0",
        virtualOuro: "0",
        token: { id: "AURYN", supply: "777.7" },
      }),
    );
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    const result = await client.getBalance({ address: "k:abc", token: "AURYN" });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get("token")).toBe("AURYN");
    expect(result.token).toEqual({ id: "AURYN", supply: "777.7" });
  });

  it('returns a Balance for a legitimate "0" 200 (NOT an error)', async () => {
    // A zero balance at 200 is a real answer — it must resolve, never reject.
    const { fetchImpl } = stubFetch(
      jsonResponse({
        chain: "stoachain",
        address: "k:abc",
        ignis: "0",
        ouroDispo: "0",
        virtualOuro: "0",
      }),
    );
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    const result = await client.getBalance({ address: "k:abc" });
    expect(result.ignis).toBe("0");
  });

  it("surfaces PythiaValidationError on a 400 required-field body", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(
        {
          code: "pythia_validation",
          error: "address is required and must be a non-empty string",
        },
        400,
      ),
    );
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    await expect(client.getBalance({ address: "" })).rejects.toBeInstanceOf(
      PythiaValidationError,
    );
  });

  it("surfaces PythiaUnsupportedChainError on a 400 unsupported-chain body", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(
        {
          code: "pythia_unsupported_chain",
          error: 'Unsupported chain: only "stoachain" is served',
        },
        400,
      ),
    );
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    await expect(client.getBalance({ address: "k:abc" })).rejects.toBeInstanceOf(
      PythiaUnsupportedChainError,
    );
  });

  it("surfaces PythiaPoolExhaustedError with failures+chainId on a 502 body", async () => {
    const failures = [
      { sourceId: "stoachain-primary", url: "https://p", cause: "down" },
      { sourceId: "stoachain-fallback", url: "https://f", cause: "down" },
    ];
    // Rebuild the Response per call — a Response body can only be read once.
    const { fetchImpl } = stubFetch(() =>
      jsonResponse(
        {
          code: "pythia_pool_exhausted",
          error: "PythiaPoolExhaustedError",
          chainId: 0,
          failures,
        },
        502,
      ),
    );
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    const err = await client.getBalance({ address: "k:abc" }).catch((e) => e);
    expect(err).toBeInstanceOf(PythiaPoolExhaustedError);
    expect(err.failures).toEqual(failures);
    expect(err.chainId).toBe(0);
  });
});

describe("PythiaClient.getConfirmations", () => {
  it("issues GET /api/v1/getConfirmations with chain=stoachain and tx, returning typed Confirmations", async () => {
    const confirmations = {
      chain: "stoachain",
      chainId: 0,
      tx: "req-key",
      status: "final",
      depth: 8,
      finalityDepth: 6,
      blockHeight: 100,
    };
    const { fetchImpl, calls } = stubFetch(jsonResponse(confirmations));
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    const result = await client.getConfirmations({ tx: "req-key" });

    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe(`${BASE}/api/v1/getConfirmations`);
    expect(url.searchParams.get("chain")).toBe("stoachain");
    expect(url.searchParams.get("tx")).toBe("req-key");
    expect(url.searchParams.has("chainId")).toBe(false);
    expect(result.status).toBe("final");
    expect(result.depth).toBe(8);
  });

  it("appends chainId to the query only when the caller provides it", async () => {
    const { fetchImpl, calls } = stubFetch(
      jsonResponse({
        chain: "stoachain",
        chainId: 3,
        tx: "req-key",
        status: "pending",
        depth: 0,
        finalityDepth: 6,
      }),
    );
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    const result = await client.getConfirmations({ tx: "req-key", chainId: 3 });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get("chainId")).toBe("3");
    expect(result.chainId).toBe(3);
  });
});

describe("PythiaClient.rpc", () => {
  it("POSTs /stoachain/rpc with {chainId?,payload} and returns the node body verbatim", async () => {
    const nodeBody = { result: { status: "success", data: 3 } };
    const { fetchImpl, calls } = stubFetch(jsonResponse(nodeBody));
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    const payload = { exec: { code: "(+ 1 2)" } };
    const result = await client.rpc({ chainId: 2, payload });

    expect(calls[0].url).toBe(`${BASE}/stoachain/rpc`);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ chainId: 2, payload });
    expect(result).toEqual(nodeBody);
  });

  it("omits chainId from the body when not provided", async () => {
    const { fetchImpl, calls } = stubFetch(jsonResponse({ ok: true }));
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    await client.rpc({ payload: { a: 1 } });

    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ payload: { a: 1 } });
  });

  it("returns a node-arrived HTTP error body verbatim (NOT remapped to a Pythia typed error)", async () => {
    // The relay passes node responses through unchanged; a node 400 is the
    // node's own payload, not Pythia's validation envelope, so it is returned.
    const nodeError = { validationFailures: ["bad pact"] };
    const { fetchImpl } = stubFetch(jsonResponse(nodeError, 400));
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    const result = await client.rpc({ payload: { exec: {} } });
    expect(result).toEqual(nodeError);
  });

  it("returns a node-origin 400 {error:string} WITHOUT a code verbatim (NOT remapped)", async () => {
    // A node's OWN 400 forwarded verbatim can also be shaped `{error:"..."}`; the
    // absence of Pythia's `code` discriminator is what keeps it a pass-through,
    // preserving the verbatim-relay contract.
    const nodeError = { error: "node says: invalid pact" };
    const { fetchImpl } = stubFetch(jsonResponse(nodeError, 400));
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    const result = await client.rpc({ payload: { exec: {} } });
    expect(result).toEqual(nodeError);
  });

  it("maps Pythia's OWN 400 bad-body envelope (with code) to PythiaValidationError", async () => {
    // Pythia's own malformed-body 400 self-identifies via `code` and is remapped.
    const { fetchImpl } = stubFetch(
      jsonResponse(
        { code: "pythia_validation", error: "Request body must be a JSON object" },
        400,
      ),
    );
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    await expect(client.rpc({ payload: null })).rejects.toBeInstanceOf(
      PythiaValidationError,
    );
  });

  it("maps a 502 pool-exhausted rpc response to PythiaPoolExhaustedError", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(
        {
          code: "pythia_pool_exhausted",
          error: "PythiaPoolExhaustedError",
          chainId: 2,
          failures: [],
        },
        502,
      ),
    );
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    await expect(client.rpc({ chainId: 2, payload: {} })).rejects.toBeInstanceOf(
      PythiaPoolExhaustedError,
    );
  });
});

describe("PythiaClient.health", () => {
  it("issues GET /healthz and returns a typed HealthSnapshot", async () => {
    const snapshot = {
      service: "ok",
      active: { sourceId: "stoachain-primary", url: "https://primary" },
      routing: "primary",
      sources: [
        { id: "stoachain-primary", url: "https://primary", role: "primary", reachable: true },
        { id: "stoachain-fallback", url: "https://fallback", role: "fallback", reachable: true },
      ],
    };
    const { fetchImpl, calls } = stubFetch(jsonResponse(snapshot));
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    const result = await client.health();

    expect(calls[0].url).toBe(`${BASE}/healthz`);
    expect(result.service).toBe("ok");
    expect(result.routing).toBe("primary");
    expect(result.sources).toHaveLength(2);
  });
});
