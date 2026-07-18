import { describe, it, expect, vi } from "vitest";
import { dial, DEFAULT_DIAL_TIMEOUT_MS } from "./dial.js";
import { PythiaPoolExhaustedError } from "./errors.js";
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

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A rejected fetch modelling a real transport failure (network down / refused). */
function transportError(message = "fetch failed"): TypeError {
  return new TypeError(message);
}

describe("dial (two-host primary/fallback failover)", () => {
  it("prefers the primary and never calls the fallback when the primary responds", async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) =>
      okResponse({ host: url }),
    );

    const res = await dial(
      { buildRequest: (host) => [`${host}/x`, {}] },
      { primary, fallback, fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://primary.example/x");
    // The dial injects a per-attempt timeout signal onto every fetch init.
    expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    await expect(res.json()).resolves.toEqual({
      host: "https://primary.example/x",
    });
  });

  it("fails over to the fallback on a primary TRANSPORT error and returns the fallback's success", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://primary.example")) throw transportError();
      return okResponse({ from: "fallback" });
    });

    const res = await dial(
      { buildRequest: (host) => [`${host}/x`, {}] },
      { primary, fallback, fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://primary.example/x");
    expect(fetchImpl.mock.calls[1][0]).toBe("https://fallback.example/x");
    await expect(res.json()).resolves.toEqual({ from: "fallback" });
  });

  it("does NOT fail over on an ARRIVED node HTTP 500 — a node-level error must not be masked", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://primary.example")) {
        return okResponse({ error: "pact failure" }, 500);
      }
      return okResponse({ from: "fallback" });
    });

    const res = await dial(
      { buildRequest: (host) => [`${host}/x`, {}] },
      { primary, fallback, fetchImpl },
    );

    // Only the primary was called; its 500 is returned verbatim, not retried.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "pact failure" });
  });

  it("throws PythiaPoolExhaustedError carrying both failures in attempt order when BOTH hosts fail transport", async () => {
    const primaryCause = transportError("primary down");
    const fallbackCause = transportError("fallback down");
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://primary.example")) throw primaryCause;
      throw fallbackCause;
    });

    await expect(
      dial(
        { buildRequest: (host) => [`${host}/x`, {}], chainId: 4 },
        { primary, fallback, fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "PythiaPoolExhaustedError",
      chainId: 4,
    });

    // Re-run to inspect the failures array shape (order + cause identity).
    let caught: PythiaPoolExhaustedError | undefined;
    try {
      await dial(
        { buildRequest: (host) => [`${host}/x`, {}], chainId: 4 },
        { primary, fallback, fetchImpl },
      );
    } catch (e) {
      caught = e as PythiaPoolExhaustedError;
    }
    expect(caught?.failures.map((f) => f.sourceId)).toEqual([
      "stoachain-primary",
      "stoachain-fallback",
    ]);
    expect(caught?.failures[0].cause).toBe(primaryCause);
    expect(caught?.failures[1].cause).toBe(fallbackCause);
  });

  it("exposes a discoverable default per-attempt timeout of 10 seconds", () => {
    // The default guards reads/relay against a node that accepts a connection
    // then hangs forever — without it, a hang is neither reject nor arrival and
    // failover never fires.
    expect(DEFAULT_DIAL_TIMEOUT_MS).toBe(10000);
  });

  it("aborts a HUNG primary via the per-attempt timeout and fails over to the fallback", async () => {
    // A node that accepts the socket then never responds must be timed out and
    // treated as a transport failure so the fallback is tried — proving a hang
    // no longer defeats failover.
    const seenSignals: (AbortSignal | undefined)[] = [];
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      seenSignals.push(init?.signal ?? undefined);
      if (url.startsWith("https://primary.example")) {
        // Never resolves on its own — only the timeout's abort can end it.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(
              Object.assign(new Error("aborted"), { name: "AbortError" }),
            ),
          );
        });
      }
      return Promise.resolve(okResponse({ from: "fallback" }));
    });

    const res = await dial(
      { buildRequest: (host) => [`${host}/x`, {}] },
      { primary, fallback, fetchImpl, timeoutMs: 20 },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://primary.example/x");
    expect(fetchImpl.mock.calls[1][0]).toBe("https://fallback.example/x");
    // Each attempt received an abort signal to enforce the timeout.
    expect(seenSignals[0]).toBeInstanceOf(AbortSignal);
    await expect(res.json()).resolves.toEqual({ from: "fallback" });
  });

  it("throws PythiaPoolExhaustedError when BOTH hosts hang past the per-attempt timeout", async () => {
    // Both nodes accept then hang: each attempt times out → both are transport
    // failures → the pool is exhausted rather than the caller hanging forever.
    const hang = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    const fetchImpl = vi.fn(hang);

    await expect(
      dial(
        { buildRequest: (host) => [`${host}/x`, {}], chainId: 7 },
        { primary, fallback, fetchImpl, timeoutMs: 20 },
      ),
    ).rejects.toMatchObject({
      name: "PythiaPoolExhaustedError",
      chainId: 7,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("preserves a caller-provided signal while ALSO enforcing the timeout (both aborts honored)", async () => {
    // If buildRequest set its own signal, the dial must merge it with the
    // timeout signal so neither the caller's cancellation nor the timeout is lost.
    const callerController = new AbortController();
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      // The merged signal must reflect BOTH sources: aborting the caller's
      // controller aborts the attempt.
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        // Trigger the caller's abort well before the (large) timeout fires.
        callerController.abort();
        // A real fetch rejects immediately when handed an already-aborted signal.
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort);
      });
    });

    await expect(
      dial(
        {
          buildRequest: (host) => [
            `${host}/x`,
            { signal: callerController.signal },
          ],
        },
        { primary, fallback, fetchImpl, timeoutMs: 5000 },
      ),
    ).rejects.toBeInstanceOf(PythiaPoolExhaustedError);
    // Both hosts saw the caller-abort → both counted as transport failures.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("is two-host only — a spurious third source in config is never dialled", async () => {
    const spuriousThird: SourceConfig = {
      id: "stoachain-extra",
      url: "https://extra.example",
      role: "fallback",
      chain: "stoa",
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://primary.example")) throw transportError();
      if (url.startsWith("https://fallback.example")) throw transportError();
      return okResponse({ from: "extra" });
    });

    await expect(
      dial(
        { buildRequest: (host) => [`${host}/x`, {}] },
        { primary, fallback, fetchImpl, extras: [spuriousThird] },
      ),
    ).rejects.toBeInstanceOf(PythiaPoolExhaustedError);

    // The extra host is never contacted — only primary + fallback (2 calls).
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const calledUrls = fetchImpl.mock.calls.map((c) => c[0]);
    expect(calledUrls.some((u) => u.startsWith("https://extra.example"))).toBe(
      false,
    );
  });
});

describe("dial onServed — per-slot attribution hook", () => {
  it("fires onServed with the node whose response arrived (primary)", async () => {
    const served: string[] = [];
    await dial(
      { buildRequest: (host) => [host, {}] },
      {
        primary,
        fallback,
        fetchImpl: async () => okResponse({ ok: true }),
        onServed: (n) => served.push(n.id),
      },
    );
    expect(served).toEqual(["stoachain-primary"]);
  });

  it("fires onServed with the FALLBACK when the primary fails transport", async () => {
    const served: string[] = [];
    const fetchImpl = async (url: string, _init?: RequestInit): Promise<Response> => {
      if (url.includes("primary")) throw new TypeError("fetch failed");
      return okResponse({ ok: true });
    };
    await dial(
      { buildRequest: (host) => [host, {}] },
      { primary, fallback, fetchImpl, onServed: (n) => served.push(n.id) },
    );
    expect(served).toEqual(["stoachain-fallback"]);
  });

  it("does NOT fire onServed when both hosts fail transport", async () => {
    const served: string[] = [];
    const fetchImpl = async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    };
    await expect(
      dial(
        { buildRequest: (host) => [host, {}] },
        { primary, fallback, fetchImpl, onServed: (n) => served.push(n.id) },
      ),
    ).rejects.toBeInstanceOf(PythiaPoolExhaustedError);
    expect(served).toEqual([]);
  });
});
