import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DualLinkConnector } from "./dualLinkConnector.js";
import { APOLLO_ACCOUNT_LEN, DUAL_LINK_BAR } from "./dualLinkKey.js";
import {
  PythiaConnectorValidationError,
  PythiaConnectorSignatureError,
} from "./connectorErrors.js";
import type { ApolloSigner } from "./connector.js";
import { PythiaClient } from "./client.js";

const BASE = "https://pythia.example";

// Real 162-char fixtures, same padding style as dualLinkKey.test.ts.
const STANDARD = "₱.".padEnd(APOLLO_ACCOUNT_LEN, "a");
const SMART = "Π.".padEnd(APOLLO_ACCOUNT_LEN, "b");
const DUAL_LINK_KEY = `${STANDARD}${DUAL_LINK_BAR}${SMART}`;

// Fixed, distinct expiresAt values per half — independent of Date.now(), so
// assertions can compare against a value known ahead of time instead of
// comparing a field of status() back against another field of the SAME
// status() call (which the review flagged as tautological when `active` is
// literally the same object reference as `standard`/`smart`).
const STANDARD_EXPIRES = 1_800_000_000_000;
const SMART_EXPIRES = 1_800_000_500_000;

/** Build a JSON Response with a given status. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A signer stub that always succeeds with a fixed signature. */
function stubSigner(signature = "sig-1"): ApolloSigner {
  return { sign: vi.fn(async () => ({ signature })) };
}

/**
 * A fetchImpl that routes canned /connectors/auth/challenge + /verify
 * responses, deciding the verify outcome per apolloAccount (mirrors
 * `selfConnectorLoop.test.ts`'s `buildStubApp`'s `failAccount` shape) — both
 * halves' `PythiaConnector`s hit the SAME two pathnames, so the response must
 * discriminate by request body, not by path alone. Records every verify
 * call's apolloAccount for call-count assertions. `verifyStatus` lets a test
 * force BOTH halves down a non-200 path (e.g. 202 "pending") without a
 * per-account fail list.
 */
function buildStubFetch(
  opts: { failAccount?: string; verifyStatus?: 200 | 202 } = {},
) {
  const verifyCalls: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/connectors/auth/challenge") {
      return jsonResponse({ nonce: "nonce-1", rp: "pythia.example", expiresAt: Date.now() + 60_000 });
    }
    if (path === "/connectors/auth/verify") {
      const body = JSON.parse(String(init?.body)) as { apolloAccount: string };
      verifyCalls.push(body.apolloAccount);
      if (opts.failAccount && body.apolloAccount === opts.failAccount) {
        return jsonResponse({ error: "signature verification failed" }, 401);
      }
      if (opts.verifyStatus === 202) {
        return jsonResponse({}, 202);
      }
      const expiresAt = body.apolloAccount === STANDARD ? STANDARD_EXPIRES : SMART_EXPIRES;
      return jsonResponse({
        secret: `secret-for-${body.apolloAccount}`,
        expiresAt,
      });
    }
    throw new Error(`no stub route for ${path}`);
  });
  return { fetchImpl, verifyCalls };
}

/**
 * Routes canned responses by URL pathname over a plain object map, recording
 * every call — mirrors `connectorIntegration.test.ts`'s `routedFetch` helper
 * exactly (no HTTP framework: this package ships zero runtime dependencies,
 * and a real `Hono` app in a test here would be an undeclared, phantom
 * dependency plus a deviation from the plan's explicit instruction to mirror
 * that lighter pattern).
 */
function routedFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ path, init });
    const route = routes[path];
    if (!route) throw new Error(`no stub route for ${path}`);
    return route(init);
  });
  return { fetchImpl, calls };
}

describe("DualLinkConnector construction", () => {
  it("throws PythiaConnectorValidationError synchronously on a malformed dualLinkKey, with no network call or signer invocation", () => {
    // `splitDualLinkKey` runs as the constructor's first statement, so a
    // malformed key fails before the field assignments that build the two
    // internal `PythiaConnector`s even run — but `PythiaConnector`'s own
    // constructor never touches `fetch` or `signer.sign` regardless of when
    // (or whether) it runs, so those two calls staying at zero is evidence
    // that NOTHING downstream fired, not proof of ordering by itself (the
    // review's own point: don't over-claim what "not called" establishes).
    const { fetchImpl } = buildStubFetch();
    const standardSigner = stubSigner();
    const smartSigner = stubSigner();

    expect(
      () =>
        new DualLinkConnector({
          dualLinkKey: "too-short",
          baseUrl: BASE,
          standardSigner,
          smartSigner,
          fetchImpl: fetchImpl as never,
        }),
    ).toThrow(PythiaConnectorValidationError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(standardSigner.sign).not.toHaveBeenCalled();
    expect(smartSigner.sign).not.toHaveBeenCalled();
  });
});

describe("DualLinkConnector.tick", () => {
  it("both halves returning 200: status() reports both active, and the top-level secret/expiresAt equal the STANDARD half's values", async () => {
    const { fetchImpl } = buildStubFetch();
    const connector = new DualLinkConnector({
      dualLinkKey: DUAL_LINK_KEY,
      baseUrl: BASE,
      standardSigner: stubSigner(),
      smartSigner: stubSigner(),
      fetchImpl: fetchImpl as never,
    });

    await connector.tick();
    const status = connector.status();

    expect(status.standard).toEqual({
      status: "active",
      secret: `secret-for-${STANDARD}`,
      expiresAt: STANDARD_EXPIRES,
    });
    expect(status.smart).toEqual({
      status: "active",
      secret: `secret-for-${SMART}`,
      expiresAt: SMART_EXPIRES,
    });
    expect(status.secret).toBe(`secret-for-${STANDARD}`);
    expect(status.expiresAt).toBe(STANDARD_EXPIRES);
  });

  it("standard fails (401), smart succeeds: standard stays pending, and top-level secret/expiresAt fall back to the smart half's values", async () => {
    const { fetchImpl } = buildStubFetch({ failAccount: STANDARD });
    const connector = new DualLinkConnector({
      dualLinkKey: DUAL_LINK_KEY,
      baseUrl: BASE,
      standardSigner: stubSigner(),
      smartSigner: stubSigner(),
      fetchImpl: fetchImpl as never,
    });

    await connector.tick();
    const status = connector.status();

    expect(status.standard).toEqual({ status: "pending" });
    expect(status.smart).toEqual({
      status: "active",
      secret: `secret-for-${SMART}`,
      expiresAt: SMART_EXPIRES,
    });
    expect(status.secret).toBe(`secret-for-${SMART}`);
    expect(status.expiresAt).toBe(SMART_EXPIRES);
  });

  it("both halves pending (202): status() reports both pending, and the top-level secret/expiresAt fall through to null", async () => {
    // Exercises the null-fallback branch of status() — never reached by
    // either single-failure test above, since one half is always active
    // there. A 202 is a legitimate steady state (see connector.ts's own
    // doc comment on Decision 3), not an error, so this is the ordinary
    // "linked but not yet active" case, not a fault-injection case.
    const { fetchImpl, verifyCalls } = buildStubFetch({ verifyStatus: 202 });
    const connector = new DualLinkConnector({
      dualLinkKey: DUAL_LINK_KEY,
      baseUrl: BASE,
      standardSigner: stubSigner(),
      smartSigner: stubSigner(),
      fetchImpl: fetchImpl as never,
    });

    await connector.tick();
    const status = connector.status();

    expect(verifyCalls).toHaveLength(2); // both halves actually ticked
    expect(status.standard).toEqual({ status: "pending" });
    expect(status.smart).toEqual({ status: "pending" });
    expect(status.secret).toBeNull();
    expect(status.expiresAt).toBeNull();
  });

  it("calls onError with exactly the failing half's name and the thrown PythiaConnectorSignatureError, without preventing the other half's tick", async () => {
    const { fetchImpl } = buildStubFetch({ failAccount: STANDARD });
    const onError = vi.fn();
    const connector = new DualLinkConnector({
      dualLinkKey: DUAL_LINK_KEY,
      baseUrl: BASE,
      standardSigner: stubSigner(),
      smartSigner: stubSigner(),
      fetchImpl: fetchImpl as never,
      onError,
    });

    await connector.tick();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe("standard");
    expect(onError.mock.calls[0][1]).toBeInstanceOf(PythiaConnectorSignatureError);
    expect(connector.status().smart.status).toBe("active"); // the other half still ticked
  });

  it("with no onError supplied, a failing half's error is reported via the default console.error fallback, naming the failing half", async () => {
    // The constructor-level default (`options.onError ?? ((half, error) =>
    // console.error(...))`) has no dedicated test anywhere else — every other
    // test in this file supplies an explicit mock, per the review's
    // untested-default-path finding.
    const { fetchImpl } = buildStubFetch({ failAccount: STANDARD });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const connector = new DualLinkConnector({
        dualLinkKey: DUAL_LINK_KEY,
        baseUrl: BASE,
        standardSigner: stubSigner(),
        smartSigner: stubSigner(),
        fetchImpl: fetchImpl as never,
        // onError intentionally omitted.
      });

      await connector.tick();

      expect(consoleError).toHaveBeenCalledTimes(1);
      const [message, error] = consoleError.mock.calls[0];
      expect(String(message)).toContain("standard");
      expect(error).toBeInstanceOf(PythiaConnectorSignatureError);
      expect(connector.status().smart.status).toBe("active");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("a second tick() shortly after the first reuses the still-valid cached secrets — no repeated verify calls, proving the SAME internal PythiaConnectors are reused", async () => {
    const { fetchImpl, verifyCalls } = buildStubFetch();
    const connector = new DualLinkConnector({
      dualLinkKey: DUAL_LINK_KEY,
      baseUrl: BASE,
      standardSigner: stubSigner(),
      smartSigner: stubSigner(),
      fetchImpl: fetchImpl as never,
    });

    await connector.tick();
    expect(verifyCalls).toHaveLength(2);

    await connector.tick();
    expect(verifyCalls).toHaveLength(2); // no new verify calls — cache hit on both halves
  });
});

describe("DualLinkConnector.start/stop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("start() drives tick()-work on the interval; stop() halts further ticks", async () => {
    const { fetchImpl, verifyCalls } = buildStubFetch();
    const connector = new DualLinkConnector({
      dualLinkKey: DUAL_LINK_KEY,
      baseUrl: BASE,
      standardSigner: stubSigner(),
      smartSigner: stubSigner(),
      fetchImpl: fetchImpl as never,
      intervalMs: 1000,
    });

    connector.start();
    expect(verifyCalls).toHaveLength(0); // no tick yet — only the interval fires it

    await vi.advanceTimersByTimeAsync(1000);
    expect(verifyCalls.length).toBeGreaterThan(0);
    const countAfterFirstTick = verifyCalls.length;

    connector.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(verifyCalls).toHaveLength(countAfterFirstTick); // no further ticks after stop()
  });

  it("start() is idempotent — a second call while already running does not create a second timer", async () => {
    const { fetchImpl, verifyCalls } = buildStubFetch();
    const connector = new DualLinkConnector({
      dualLinkKey: DUAL_LINK_KEY,
      baseUrl: BASE,
      standardSigner: stubSigner(),
      smartSigner: stubSigner(),
      fetchImpl: fetchImpl as never,
      intervalMs: 1000,
    });

    connector.start();
    connector.start(); // second call — must be a no-op, not a second interval

    await vi.advanceTimersByTimeAsync(1000);
    // A doubled timer would fire tick() twice per interval (4 verify calls —
    // 2 halves x 2 concurrent ticks); one timer fires it once (2 halves).
    expect(verifyCalls.length).toBe(2);
    connector.stop();
  });
});

describe("DualLinkConnector + PythiaClient integration", () => {
  it("keyProvider() wired into a real PythiaClient's pythiaKey option: a client.read() call carries x-pythia-key equal to status().secret", async () => {
    // Proves DualLinkConnectorOptions.keyProvider() actually reaches a real
    // PythiaClient end to end — mirrors connectorIntegration.test.ts's own
    // routedFetch-stub pattern (no HTTP framework), generalized to the
    // dual-link case's two-halves-share-one-pathname shape.
    const capturedReadHeaders: Array<Record<string, string>> = [];
    const { fetchImpl } = routedFetch({
      "/connectors/auth/challenge": () =>
        jsonResponse({ nonce: "n1", rp: "pythia.example", expiresAt: Date.now() + 60_000 }),
      "/connectors/auth/verify": (init) => {
        const body = JSON.parse(String(init?.body)) as { apolloAccount: string };
        const which = body.apolloAccount === STANDARD ? "standard" : "smart";
        // An ASCII-only secret — the fixture accounts themselves contain the
        // ₱/Π codepoints, which the Fetch Headers API rejects as byte-string
        // header values, so the secret can't just embed the raw account text.
        return jsonResponse({ secret: `secret-for-${which}`, expiresAt: Date.now() + 3_600_000 });
      },
      "/stoachain/read": (init) => {
        capturedReadHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
        return jsonResponse({ result: { status: "success", data: "ok" } });
      },
    });

    const connector = new DualLinkConnector({
      dualLinkKey: DUAL_LINK_KEY,
      baseUrl: BASE,
      standardSigner: stubSigner(),
      smartSigner: stubSigner(),
      fetchImpl: fetchImpl as never,
    });
    const client = new PythiaClient({
      baseUrl: BASE,
      fetchImpl: fetchImpl as never,
      pythiaKey: connector.keyProvider(),
    });

    await client.read({ code: "(+ 1 1)" });

    expect(capturedReadHeaders).toHaveLength(1);
    expect(capturedReadHeaders[0]["x-pythia-key"]).toBe(connector.status().secret);
    expect(connector.status().secret).toBe("secret-for-standard");
  });
});
