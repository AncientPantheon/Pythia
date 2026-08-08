import { describe, it, expect, vi } from "vitest";
import { PythiaConnector, type ApolloSigner } from "./connector.js";
import {
  PythiaConnectorValidationError,
  PythiaConnectorSignatureError,
  PythiaConnectorNotLinkedError,
  PythiaConnectorUnavailableError,
} from "./connectorErrors.js";

const BASE = "https://pythia.example";
const ACCOUNT = "k:apollo-account";

/** Build a JSON Response with a given status. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A fetchImpl that routes canned responses by URL pathname (the connector
 * round trip needs two different endpoints to respond differently, unlike
 * PythiaClient's single-call tests) and records every call for spy
 * assertions.
 */
function routedFetch(routes: Record<string, Response | (() => Response)>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) throw new Error(`no stub route for ${path}`);
    return typeof route === "function" ? route() : route;
  });
  return { fetchImpl, calls };
}

/** A signer stub that always succeeds with a fixed signature. */
function stubSigner(signature = "sig-1"): ApolloSigner {
  return { sign: vi.fn(async () => ({ signature })) };
}

const CHALLENGE_OK = { nonce: "nonce-1", rp: "pythia.example", expiresAt: Date.now() + 60_000 };

describe("PythiaConnector.ensureSecret", () => {
  it("drives the full challenge -> sign -> verify sequence and returns an active secret", async () => {
    // Proves the happy path actually performs all three round-trip legs in
    // order, wiring the challenge's nonce/rp into the signer and the
    // signer's signature into verify — not just that SOME network call happens.
    const { fetchImpl, calls } = routedFetch({
      "/connectors/auth/challenge": jsonResponse(CHALLENGE_OK),
      "/connectors/auth/verify": jsonResponse({
        secret: "pk_live_abc",
        expiresAt: Date.now() + 3_600_000,
      }),
    });
    const signer = stubSigner("sig-xyz");
    const connector = new PythiaConnector({
      baseUrl: BASE,
      apolloAccount: ACCOUNT,
      signer,
      fetchImpl: fetchImpl as never,
    });

    const result = await connector.ensureSecret();

    expect(result).toEqual({
      status: "active",
      secret: "pk_live_abc",
      expiresAt: expect.any(Number),
    });
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0].url).pathname).toBe("/connectors/auth/challenge");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      apolloAccount: ACCOUNT,
    });
    expect(signer.sign).toHaveBeenCalledWith({
      apolloAccount: ACCOUNT,
      nonce: "nonce-1",
      rp: "pythia.example",
    });
    expect(new URL(calls[1].url).pathname).toBe("/connectors/auth/verify");
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      apolloAccount: ACCOUNT,
      nonce: "nonce-1",
      signature: "sig-xyz",
    });
  });

  it("returns the cached secret with zero further network/signer calls when still fresh", async () => {
    // The whole point of caching is to avoid a redundant round trip on every
    // call; a call-count spy on both fetchImpl and the signer proves neither
    // fires the second time, not just that the second result "looks right".
    const { fetchImpl } = routedFetch({
      "/connectors/auth/challenge": jsonResponse(CHALLENGE_OK),
      "/connectors/auth/verify": jsonResponse({
        secret: "pk_live_abc",
        expiresAt: Date.now() + 3_600_000,
      }),
    });
    const signer = stubSigner();
    const connector = new PythiaConnector({
      baseUrl: BASE,
      apolloAccount: ACCOUNT,
      signer,
      fetchImpl: fetchImpl as never,
    });

    const first = await connector.ensureSecret();
    const fetchCallsAfterFirst = fetchImpl.mock.calls.length;
    const signCallsAfterFirst = (signer.sign as ReturnType<typeof vi.fn>).mock
      .calls.length;

    const second = await connector.ensureSecret();

    expect(second).toEqual(first);
    expect(fetchImpl.mock.calls.length).toBe(fetchCallsAfterFirst);
    expect((signer.sign as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      signCallsAfterFirst,
    );
  });

  it("returns {status:'pending'} without throwing on a 202 verify response", async () => {
    // A brand-new, not-yet-active dual link is an expected steady state per
    // the design's Decision 3 — must be a typed result, never a thrown error.
    const { fetchImpl } = routedFetch({
      "/connectors/auth/challenge": jsonResponse(CHALLENGE_OK),
      "/connectors/auth/verify": jsonResponse(
        { error: "ownership proven, but not yet an active dual link" },
        202,
      ),
    });
    const connector = new PythiaConnector({
      baseUrl: BASE,
      apolloAccount: ACCOUNT,
      signer: stubSigner(),
      fetchImpl: fetchImpl as never,
    });

    await expect(connector.ensureSecret()).resolves.toEqual({
      status: "pending",
    });
  });

  it.each([
    [400, PythiaConnectorValidationError],
    [401, PythiaConnectorSignatureError],
    [403, PythiaConnectorNotLinkedError],
    [502, PythiaConnectorUnavailableError],
  ] as const)(
    "maps a %i verify response to the correct typed error",
    async (status, ErrorClass) => {
      const { fetchImpl } = routedFetch({
        "/connectors/auth/challenge": jsonResponse(CHALLENGE_OK),
        "/connectors/auth/verify": jsonResponse({ error: "mapped" }, status),
      });
      const connector = new PythiaConnector({
        baseUrl: BASE,
        apolloAccount: ACCOUNT,
        signer: stubSigner(),
        fetchImpl: fetchImpl as never,
      });

      await expect(connector.ensureSecret()).rejects.toBeInstanceOf(
        ErrorClass,
      );
    },
  );

  it("throws PythiaConnectorValidationError on a 400 challenge response and never calls the signer", async () => {
    // A 400 on challenge means the account itself was rejected — signing a
    // nonce that was never issued would be meaningless, so the signer must
    // not be invoked at all.
    const { fetchImpl } = routedFetch({
      "/connectors/auth/challenge": jsonResponse(
        { error: "invalid apollo account" },
        400,
      ),
    });
    const signer = stubSigner();
    const connector = new PythiaConnector({
      baseUrl: BASE,
      apolloAccount: ACCOUNT,
      signer,
      fetchImpl: fetchImpl as never,
    });

    await expect(connector.ensureSecret()).rejects.toBeInstanceOf(
      PythiaConnectorValidationError,
    );
    expect(signer.sign).not.toHaveBeenCalled();
  });

  it("throws the base PythiaConnectorError (NOT a validation error) on an unexpected non-400 challenge status, e.g. a transient 502", async () => {
    // Regression: an infra-level failure (gateway 502/503, or an HTML error
    // page relayed verbatim) must not be mislabeled as "invalid apollo
    // account" — that's a genuinely different, non-retryable-sounding failure
    // class from a real input-validation problem.
    const { fetchImpl } = routedFetch({
      "/connectors/auth/challenge": () =>
        jsonResponse("<html>Bad Gateway</html>", 502),
    });
    const signer = stubSigner();
    const connector = new PythiaConnector({
      baseUrl: BASE,
      apolloAccount: ACCOUNT,
      signer,
      fetchImpl: fetchImpl as never,
    });

    let caught: unknown;
    try {
      await connector.ensureSecret();
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(PythiaConnectorValidationError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/502/);
    expect(signer.sign).not.toHaveBeenCalled();
  });

  it("a mapped-error verify status with a non-JSON-object body (e.g. an HTML gateway page) still throws with the fallback message, not a crash", async () => {
    // bodyErrorMessage's whole reason to exist is defending exactly this
    // shape — previously untested, so a regression that crashed the mapper
    // or produced "undefined"/"[object Object]" would have gone unnoticed.
    const { fetchImpl } = routedFetch({
      "/connectors/auth/challenge": jsonResponse(CHALLENGE_OK),
      "/connectors/auth/verify": () =>
        new Response("<html>Unauthorized</html>", {
          status: 401,
          headers: { "content-type": "text/html" },
        }),
    });
    const connector = new PythiaConnector({
      baseUrl: BASE,
      apolloAccount: ACCOUNT,
      signer: stubSigner(),
      fetchImpl: fetchImpl as never,
    });

    await expect(connector.ensureSecret()).rejects.toThrow(
      "signature verification failed",
    );
  });

  it("clears a previously-stored secret when a later refresh returns 202 pending", async () => {
    // Regression: distinguishes "storage.clear() actually ran" from "storage
    // started empty" — the prior test only proved the latter.
    let phase: "active" | "pending" = "active";
    const { fetchImpl } = routedFetch({
      "/connectors/auth/challenge": () => jsonResponse(CHALLENGE_OK),
      "/connectors/auth/verify": () =>
        phase === "active"
          ? jsonResponse({ secret: "pk_live_stale", expiresAt: Date.now() + 3_600_000 })
          : jsonResponse({ error: "not yet active" }, 202),
    });
    const connector = new PythiaConnector({
      baseUrl: BASE,
      apolloAccount: ACCOUNT,
      signer: stubSigner(),
      fetchImpl: fetchImpl as never,
    });

    const first = await connector.refresh();
    expect(first).toEqual({
      status: "active",
      secret: "pk_live_stale",
      expiresAt: expect.any(Number),
    });

    phase = "pending";
    const second = await connector.refresh();
    expect(second).toEqual({ status: "pending" });

    // If storage.clear() didn't actually run, ensureSecret() would still
    // find the stale cached "pk_live_stale" entry (its expiresAt is still
    // an hour out) and hand it back without ever calling refresh() again.
    const third = await connector.ensureSecret();
    expect(third).toEqual({ status: "pending" });
  });

  it("treats a cached secret INSIDE the refresh margin as needing refresh, not just an already-expired one", async () => {
    const { fetchImpl } = routedFetch({
      "/connectors/auth/challenge": jsonResponse(CHALLENGE_OK),
      "/connectors/auth/verify": jsonResponse({
        secret: "pk_live_fresh",
        expiresAt: Date.now() + 3_600_000,
      }),
    });
    const refreshMarginMs = 5 * 60 * 1000;
    const storage = {
      entry: {
        secret: "pk_live_about_to_expire",
        // Inside the margin (3 of the 5 minutes left) — must NOT be treated
        // as still-valid, or a consumer's in-flight request could race an
        // about-to-expire secret.
        expiresAt: Date.now() + 3 * 60 * 1000,
      } as { secret: string; expiresAt: number } | null,
      async load() {
        return this.entry;
      },
      async save(e: { secret: string; expiresAt: number }) {
        this.entry = e;
      },
      async clear() {
        this.entry = null;
      },
    };
    const connector = new PythiaConnector({
      baseUrl: BASE,
      apolloAccount: ACCOUNT,
      signer: stubSigner(),
      storage,
      refreshMarginMs,
      fetchImpl: fetchImpl as never,
    });

    const result = await connector.ensureSecret();

    expect(result).toEqual({
      status: "active",
      secret: "pk_live_fresh",
      expiresAt: expect.any(Number),
    });
    expect(fetchImpl).toHaveBeenCalled(); // proves a real refresh happened, not the stale cache
  });

  it("concurrent ensureSecret() calls with nothing cached share ONE in-flight refresh — not one per caller", async () => {
    // Regression: without dedup, two callers racing ensureSecret() (e.g. two
    // simultaneous PythiaClient requests both consulting keyProvider()) would
    // each independently fire their own challenge+sign+verify round trip.
    let challengeCalls = 0;
    let verifyCalls = 0;
    const { fetchImpl } = routedFetch({
      "/connectors/auth/challenge": () => {
        challengeCalls += 1;
        return jsonResponse(CHALLENGE_OK);
      },
      "/connectors/auth/verify": () => {
        verifyCalls += 1;
        return jsonResponse({
          secret: "pk_live_shared",
          expiresAt: Date.now() + 3_600_000,
        });
      },
    });
    const signer = stubSigner();
    const connector = new PythiaConnector({
      baseUrl: BASE,
      apolloAccount: ACCOUNT,
      signer,
      fetchImpl: fetchImpl as never,
    });

    const [a, b] = await Promise.all([
      connector.ensureSecret(),
      connector.ensureSecret(),
    ]);

    expect(a).toEqual(b);
    expect(challengeCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    expect((signer.sign as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("a failed in-flight refresh does not wedge a later, separate refresh attempt", async () => {
    // The `refreshing` memoization must clear on failure too, or every call
    // after one failure would be stuck awaiting the same rejected promise.
    let attempt = 0;
    const { fetchImpl } = routedFetch({
      "/connectors/auth/challenge": () => {
        attempt += 1;
        return attempt === 1
          ? jsonResponse({ error: "invalid apollo account" }, 400)
          : jsonResponse(CHALLENGE_OK);
      },
      "/connectors/auth/verify": jsonResponse({
        secret: "pk_live_after_retry",
        expiresAt: Date.now() + 3_600_000,
      }),
    });
    const connector = new PythiaConnector({
      baseUrl: BASE,
      apolloAccount: ACCOUNT,
      signer: stubSigner(),
      fetchImpl: fetchImpl as never,
    });

    await expect(connector.ensureSecret()).rejects.toBeInstanceOf(
      PythiaConnectorValidationError,
    );
    await expect(connector.ensureSecret()).resolves.toEqual({
      status: "active",
      secret: "pk_live_after_retry",
      expiresAt: expect.any(Number),
    });
  });
});

describe("PythiaConnector.keyProvider", () => {
  it("resolves to the active secret string on a successful round trip", async () => {
    const { fetchImpl } = routedFetch({
      "/connectors/auth/challenge": jsonResponse(CHALLENGE_OK),
      "/connectors/auth/verify": jsonResponse({
        secret: "pk_live_provider",
        expiresAt: Date.now() + 3_600_000,
      }),
    });
    const connector = new PythiaConnector({
      baseUrl: BASE,
      apolloAccount: ACCOUNT,
      signer: stubSigner(),
      fetchImpl: fetchImpl as never,
    });

    const provider = connector.keyProvider();

    await expect(provider()).resolves.toBe("pk_live_provider");
  });

  it("resolves to undefined instead of rejecting when ensureSecret throws", async () => {
    // This closure feeds PythiaClientOptions.pythiaKey; a rejection here would
    // break an otherwise-unrelated read/send/poll call, so any thrown
    // PythiaConnectorError must be swallowed into undefined, not propagated.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fetchImpl } = routedFetch({
      "/connectors/auth/challenge": jsonResponse(CHALLENGE_OK),
      "/connectors/auth/verify": jsonResponse(
        { error: "signature verification failed" },
        401,
      ),
    });
    const connector = new PythiaConnector({
      baseUrl: BASE,
      apolloAccount: ACCOUNT,
      signer: stubSigner(),
      fetchImpl: fetchImpl as never,
    });

    const provider = connector.keyProvider();

    await expect(provider()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("resolves to undefined WITHOUT logging an error when the account is legitimately pending (202) — a distinct path from the error-swallow above", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fetchImpl } = routedFetch({
      "/connectors/auth/challenge": jsonResponse(CHALLENGE_OK),
      "/connectors/auth/verify": jsonResponse({ error: "not active yet" }, 202),
    });
    const connector = new PythiaConnector({
      baseUrl: BASE,
      apolloAccount: ACCOUNT,
      signer: stubSigner(),
      fetchImpl: fetchImpl as never,
    });

    const provider = connector.keyProvider();

    await expect(provider()).resolves.toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("routes a swallowed error through a custom onKeyProviderError instead of the default console.error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onKeyProviderError = vi.fn();
    const { fetchImpl } = routedFetch({
      "/connectors/auth/challenge": jsonResponse(CHALLENGE_OK),
      "/connectors/auth/verify": jsonResponse(
        { error: "signature verification failed" },
        401,
      ),
    });
    const connector = new PythiaConnector({
      baseUrl: BASE,
      apolloAccount: ACCOUNT,
      signer: stubSigner(),
      fetchImpl: fetchImpl as never,
      onKeyProviderError,
    });

    const provider = connector.keyProvider();

    await expect(provider()).resolves.toBeUndefined();
    expect(onKeyProviderError).toHaveBeenCalledTimes(1);
    expect(onKeyProviderError.mock.calls[0][0]).toBeInstanceOf(
      PythiaConnectorSignatureError,
    );
    expect(errorSpy).not.toHaveBeenCalled(); // the custom hook REPLACES the default, doesn't add to it
    errorSpy.mockRestore();
  });

  it("routes an error thrown by the caller's OWN injected signer through onKeyProviderError too — not just this SDK's own error types", async () => {
    const onKeyProviderError = vi.fn();
    const brokenSigner: ApolloSigner = {
      sign: vi.fn(async () => {
        throw new Error("signer blew up");
      }),
    };
    const { fetchImpl } = routedFetch({
      "/connectors/auth/challenge": jsonResponse(CHALLENGE_OK),
    });
    const connector = new PythiaConnector({
      baseUrl: BASE,
      apolloAccount: ACCOUNT,
      signer: brokenSigner,
      fetchImpl: fetchImpl as never,
      onKeyProviderError,
    });

    const provider = connector.keyProvider();

    await expect(provider()).resolves.toBeUndefined();
    expect(onKeyProviderError).toHaveBeenCalledTimes(1);
    expect((onKeyProviderError.mock.calls[0][0] as Error).message).toBe(
      "signer blew up",
    );
  });
});

describe("PythiaConnector.invalidate + asKeySource (401 self-heal)", () => {
  it("invalidate() drops the cached secret so the next ensureSecret() re-mints", async () => {
    const active = () => jsonResponse({ secret: "pk_live_x", expiresAt: Date.now() + 3_600_000 });
    const { fetchImpl, calls } = routedFetch({
      "/connectors/auth/challenge": () => jsonResponse(CHALLENGE_OK),
      "/connectors/auth/verify": active,
    });
    const connector = new PythiaConnector({ baseUrl: BASE, apolloAccount: ACCOUNT, signer: stubSigner(), fetchImpl: fetchImpl as never });

    await connector.ensureSecret(); // mint (2 calls)
    await connector.ensureSecret(); // cached — no new calls
    expect(calls).toHaveLength(2);

    await connector.invalidate();
    await connector.ensureSecret(); // must re-mint (2 more calls)
    expect(calls).toHaveLength(4);
  });

  it("asKeySource().get() returns the live secret; invalidate() forces a re-mint on next get()", async () => {
    const { fetchImpl, calls } = routedFetch({
      "/connectors/auth/challenge": () => jsonResponse(CHALLENGE_OK),
      "/connectors/auth/verify": () => jsonResponse({ secret: "pk_live_x", expiresAt: Date.now() + 3_600_000 }),
    });
    const connector = new PythiaConnector({ baseUrl: BASE, apolloAccount: ACCOUNT, signer: stubSigner(), fetchImpl: fetchImpl as never });
    const src = connector.asKeySource();

    expect(await src.get()).toBe("pk_live_x");
    expect(calls).toHaveLength(2);
    await src.get(); // cached
    expect(calls).toHaveLength(2);
    await src.invalidate();
    expect(await src.get()).toBe("pk_live_x"); // re-minted
    expect(calls).toHaveLength(4);
  });

  it("asKeySource().get() returns undefined when the connector is pending (202)", async () => {
    const { fetchImpl } = routedFetch({
      "/connectors/auth/challenge": () => jsonResponse(CHALLENGE_OK),
      "/connectors/auth/verify": () => jsonResponse({ error: "not active yet" }, 202),
    });
    const connector = new PythiaConnector({ baseUrl: BASE, apolloAccount: ACCOUNT, signer: stubSigner(), fetchImpl: fetchImpl as never });
    expect(await connector.asKeySource().get()).toBeUndefined();
  });
})
