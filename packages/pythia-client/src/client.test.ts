import { describe, it, expect, vi } from "vitest";
import { PythiaClient } from "./client.js";
import {
  PythiaValidationError,
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

describe("PythiaClient.read", () => {
  it("POSTs /stoachain/read with {chainId?,code,data?,sender?} and returns the node body verbatim", async () => {
    const nodeBody = { result: { status: "success", data: 3 } };
    const { fetchImpl, calls } = stubFetch(jsonResponse(nodeBody));
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    const result = await client.read({
      chainId: 2,
      code: "(+ 1 2)",
      data: { a: 1 },
      sender: "k:x",
    });

    expect(calls[0].url).toBe(`${BASE}/stoachain/read`);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      chainId: 2,
      code: "(+ 1 2)",
      data: { a: 1 },
      sender: "k:x",
    });
    expect(result).toEqual(nodeBody);
  });

  it("omits chainId/data/sender from the body when not provided", async () => {
    const { fetchImpl, calls } = stubFetch(jsonResponse({ ok: true }));
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    await client.read({ code: "(f)" });

    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ code: "(f)" });
  });

  it("returns a node-arrived failure envelope verbatim (a keys-required read is NOT an error)", async () => {
    // A read needing caps comes back as the node's failure result; the client
    // must return it unchanged, never remap it to a thrown error.
    const nodeFailure = {
      result: { status: "failure", error: { message: "Keyset failure" } },
    };
    const { fetchImpl } = stubFetch(jsonResponse(nodeFailure));
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    const result = await client.read({ code: "(protected)" });
    expect(result).toEqual(nodeFailure);
  });

  it("maps Pythia's OWN 400 bad-code envelope (with code) to PythiaValidationError", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(
        { code: "pythia_validation", error: "code is required and must be a non-empty string" },
        400,
      ),
    );
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    await expect(client.read({ code: "" })).rejects.toBeInstanceOf(
      PythiaValidationError,
    );
  });

  it("maps a 502 pool-exhausted read response to PythiaPoolExhaustedError", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(
        { code: "pythia_pool_exhausted", error: "PythiaPoolExhaustedError", chainId: 2, failures: [] },
        502,
      ),
    );
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    await expect(client.read({ chainId: 2, code: "(f)" })).rejects.toBeInstanceOf(
      PythiaPoolExhaustedError,
    );
  });
});

describe("PythiaClient.send", () => {
  it("POSTs /stoachain/send with {chainId?,cmds} and returns the node body verbatim", async () => {
    const cmds = [{ cmd: "{}", hash: "h", sigs: [{ sig: "s" }] }];
    const nodeBody = { requestKeys: ["rk-1"] };
    const { fetchImpl, calls } = stubFetch(jsonResponse(nodeBody));
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    const result = await client.send({ chainId: 1, cmds });

    expect(calls[0].url).toBe(`${BASE}/stoachain/send`);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ chainId: 1, cmds });
    // Keyless: the caller's own sig is forwarded unchanged.
    expect(JSON.parse(String(calls[0].init?.body)).cmds[0].sigs).toEqual([{ sig: "s" }]);
    expect(result).toEqual(nodeBody);
  });

  it("omits chainId from the body when not provided", async () => {
    const { fetchImpl, calls } = stubFetch(jsonResponse({ requestKeys: [] }));
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    await client.send({ cmds: [{ cmd: "{}" }] });

    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ cmds: [{ cmd: "{}" }] });
  });

  it("returns a node-arrived HTTP error body verbatim (NOT remapped)", async () => {
    const nodeError = { error: "Validation failed" };
    const { fetchImpl } = stubFetch(jsonResponse(nodeError, 400));
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    const result = await client.send({ cmds: [{ cmd: "{}" }] });
    expect(result).toEqual(nodeError);
  });

  it("maps a 502 pool-exhausted send response to PythiaPoolExhaustedError", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(
        { code: "pythia_pool_exhausted", error: "PythiaPoolExhaustedError", failures: [] },
        502,
      ),
    );
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    await expect(client.send({ cmds: [{ cmd: "{}" }] })).rejects.toBeInstanceOf(
      PythiaPoolExhaustedError,
    );
  });
});

describe("PythiaClient.poll", () => {
  it("POSTs /stoachain/poll with {chainId?,requestKeys} and returns the typed PollResult", async () => {
    const pollResult = {
      chainId: 0,
      finalityDepth: 6,
      results: {
        "rk-a": { status: "final", depth: 8, blockHeight: 100 },
        "rk-b": { status: "pending", depth: 0 },
      },
    };
    const { fetchImpl, calls } = stubFetch(jsonResponse(pollResult));
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    const result = await client.poll({ requestKeys: ["rk-a", "rk-b"] });

    expect(calls[0].url).toBe(`${BASE}/stoachain/poll`);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      requestKeys: ["rk-a", "rk-b"],
    });
    expect(result.results["rk-a"]).toEqual({ status: "final", depth: 8, blockHeight: 100 });
    expect(result.results["rk-b"].status).toBe("pending");
  });

  it("includes chainId in the body only when provided", async () => {
    const { fetchImpl, calls } = stubFetch(
      jsonResponse({ chainId: 3, finalityDepth: 6, results: {} }),
    );
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    await client.poll({ chainId: 3, requestKeys: ["rk-a"] });

    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      chainId: 3,
      requestKeys: ["rk-a"],
    });
  });

  it("maps a 400 empty-requestKeys envelope to PythiaValidationError", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(
        { code: "pythia_validation", error: "requestKeys is required and must be a non-empty array" },
        400,
      ),
    );
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    await expect(client.poll({ requestKeys: [] })).rejects.toBeInstanceOf(
      PythiaValidationError,
    );
  });

  it("maps a 502 pool-exhausted poll response to PythiaPoolExhaustedError", async () => {
    const failures = [
      { sourceId: "stoachain-primary", url: "https://p", cause: "down" },
      { sourceId: "stoachain-fallback", url: "https://f", cause: "down" },
    ];
    const { fetchImpl } = stubFetch(
      jsonResponse(
        { code: "pythia_pool_exhausted", error: "PythiaPoolExhaustedError", chainId: 0, failures },
        502,
      ),
    );
    const client = new PythiaClient({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    const err = await client.poll({ requestKeys: ["rk-a"] }).catch((e) => e);
    expect(err).toBeInstanceOf(PythiaPoolExhaustedError);
    expect(err.failures).toEqual(failures);
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
