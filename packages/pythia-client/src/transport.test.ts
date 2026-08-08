import { describe, it, expect, vi } from "vitest";
import { Transport } from "./transport.js";

const BASE = "https://pythia.example";

function stubFetch(response: Response) {
  const fetchImpl = vi.fn(async () => response);
  return fetchImpl;
}

describe("Transport JSON decoding resilience", () => {
  it("does NOT throw a raw SyntaxError when a relay body is non-JSON on GET", async () => {
    // A node/gateway 5xx forwarded verbatim can be HTML or empty; the transport
    // must surface it as a usable {status, body} pair, not a decode crash.
    const transport = new Transport({
      baseUrl: BASE,
      fetchImpl: stubFetch(
        new Response("<html>502 Bad Gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
      ) as never,
    });

    const parsed = await transport.get("/stoachain/read");
    expect(parsed.status).toBe(502);
    // The caller maps by status; the raw text is preserved as the body.
    expect(parsed.body).toBe("<html>502 Bad Gateway</html>");
  });

  it("returns the raw text body for a non-JSON POST relay response", async () => {
    const transport = new Transport({
      baseUrl: BASE,
      fetchImpl: stubFetch(
        new Response("", { status: 503 }),
      ) as never,
    });

    const parsed = await transport.postJson("/stoachain/read", { a: 1 });
    expect(parsed.status).toBe(503);
    // An empty body decodes to the empty string, not a thrown SyntaxError.
    expect(parsed.body).toBe("");
  });

  it("still parses a valid JSON body into an object on POST", async () => {
    // The happy path must be unchanged: valid JSON is decoded to its object.
    const transport = new Transport({
      baseUrl: BASE,
      fetchImpl: stubFetch(
        new Response(JSON.stringify({ result: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ) as never,
    });

    const parsed = await transport.postJson("/stoachain/read", { a: 1 });
    expect(parsed.status).toBe(200);
    expect(parsed.body).toEqual({ result: "ok" });
  });
});

describe("Transport x-pythia-key gated-access header", () => {
  /** Each call needs a FRESH Response, since a Body can only be read once
   * (transport.get/postJson both consume it via `.text()`). */
  function okFetch() {
    return vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  it("sends no x-pythia-key header when no pythiaKey option is given", async () => {
    // A consumer that never opts in to gated access must not send ANY
    // x-pythia-key header at all — the gateway falls through to anonymous
    // access, and a stray header (even empty-string) would be wrong.
    const fetchImpl = okFetch();
    const transport = new Transport({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    await transport.get("/stoachain/read");

    const init = fetchImpl.mock.calls[0][1] as RequestInit | undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect("x-pythia-key" in headers).toBe(false);
  });

  it("attaches a static string pythiaKey to both get() and postJson() requests", async () => {
    const fetchImpl = okFetch();
    const transport = new Transport({
      baseUrl: BASE,
      fetchImpl: fetchImpl as never,
      pythiaKey: "static-secret-key",
    });

    await transport.get("/stoachain/read");
    await transport.postJson("/stoachain/send", { a: 1 });

    const getInit = fetchImpl.mock.calls[0][1] as RequestInit | undefined;
    const postInit = fetchImpl.mock.calls[1][1] as RequestInit | undefined;
    expect((getInit?.headers as Record<string, string>)["x-pythia-key"]).toBe(
      "static-secret-key",
    );
    expect((postInit?.headers as Record<string, string>)["x-pythia-key"]).toBe(
      "static-secret-key",
    );
  });

  it("calls a supplier function fresh on every request and sends its resolved value", async () => {
    // This is the live-connector case: the supplier (e.g.
    // connector.keyProvider()) must be re-invoked per request, never cached,
    // so a rotated/expired ephemeral secret is picked up on the next call.
    const fetchImpl = okFetch();
    let calls = 0;
    const supplier = vi.fn(async () => {
      calls += 1;
      return `live-secret-${calls}`;
    });
    const transport = new Transport({
      baseUrl: BASE,
      fetchImpl: fetchImpl as never,
      pythiaKey: supplier,
    });

    await transport.get("/stoachain/read");
    await transport.get("/stoachain/read");

    expect(supplier).toHaveBeenCalledTimes(2);
    const firstInit = fetchImpl.mock.calls[0][1] as RequestInit | undefined;
    const secondInit = fetchImpl.mock.calls[1][1] as RequestInit | undefined;
    expect((firstInit?.headers as Record<string, string>)["x-pythia-key"]).toBe(
      "live-secret-1",
    );
    expect((secondInit?.headers as Record<string, string>)["x-pythia-key"]).toBe(
      "live-secret-2",
    );
  });

  it("sends no x-pythia-key header when the supplier resolves to undefined", async () => {
    const fetchImpl = okFetch();
    const supplier = vi.fn(async () => undefined);
    const transport = new Transport({
      baseUrl: BASE,
      fetchImpl: fetchImpl as never,
      pythiaKey: supplier,
    });

    await transport.get("/stoachain/read");

    const init = fetchImpl.mock.calls[0][1] as RequestInit | undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect("x-pythia-key" in headers).toBe(false);
  });

  it("sends no x-pythia-key header on postJson() specifically when no pythiaKey option is given", async () => {
    // Regression: get() and postJson() build their headers object with two
    // DIFFERENT code shapes (postJson always spreads a content-type header
    // alongside the conditional key) — the "no option" case was previously
    // only ever exercised via get(), leaving postJson()'s own branch untested.
    const fetchImpl = okFetch();
    const transport = new Transport({ baseUrl: BASE, fetchImpl: fetchImpl as never });

    await transport.postJson("/stoachain/send", { a: 1 });

    const init = fetchImpl.mock.calls[0][1] as RequestInit | undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect("x-pythia-key" in headers).toBe(false);
    expect(headers["content-type"]).toBe("application/json"); // the real header still goes out
  });

  it("sends no x-pythia-key header for an empty-string pythiaKey — a static string or a supplier resolving to ''", async () => {
    // Regression: the "non-empty string" contract relies on a truthiness
    // check; a future change to an `!== undefined` check would start
    // sending a literal empty-string header and pass every other test here.
    const fetchImplStatic = okFetch();
    const transportStatic = new Transport({
      baseUrl: BASE,
      fetchImpl: fetchImplStatic as never,
      pythiaKey: "",
    });
    await transportStatic.get("/stoachain/read");
    const staticInit = fetchImplStatic.mock.calls[0][1] as RequestInit | undefined;
    expect("x-pythia-key" in ((staticInit?.headers ?? {}) as Record<string, string>)).toBe(false);

    const fetchImplSupplier = okFetch();
    const transportSupplier = new Transport({
      baseUrl: BASE,
      fetchImpl: fetchImplSupplier as never,
      pythiaKey: async () => "",
    });
    await transportSupplier.get("/stoachain/read");
    const supplierInit = fetchImplSupplier.mock.calls[0][1] as RequestInit | undefined;
    expect("x-pythia-key" in ((supplierInit?.headers ?? {}) as Record<string, string>)).toBe(false);
  });
});

describe("Transport — 401 self-heal (invalid/expired connector key)", () => {
  // A fetch stub that returns a 401 invalid-key body the FIRST N times, then 200.
  function healingFetch(opts: { fail: number; body401?: unknown }) {
    let calls = 0;
    const sentKeys: (string | null)[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sentKeys.push(headers["x-pythia-key"] ?? null);
      if (calls <= opts.fail) {
        return new Response(
          JSON.stringify(opts.body401 ?? { error: "invalid or expired connector key" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    return { fetchImpl, sentKeys, calls: () => calls };
  }

  function refreshableKey() {
    let n = 0;
    const invalidate = vi.fn(async () => {});
    const get = vi.fn(async () => `pk_eph_key-${n}`);
    // each invalidate bumps the minted key so the retry sends a DIFFERENT one
    invalidate.mockImplementation(async () => { n += 1; });
    return { get, invalidate };
  }

  it("(a) on the target 401, invalidates once + re-mints + retries once, and the retry succeeds", async () => {
    const { fetchImpl, sentKeys } = healingFetch({ fail: 1 });
    const key = refreshableKey();
    const t = new Transport({ baseUrl: BASE, fetchImpl: fetchImpl as never, pythiaKey: key });
    const res = await t.postJson("/stoachain/send", { cmds: [] });
    expect(res.status).toBe(200);
    expect(key.invalidate).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // original + one retry
    expect(sentKeys).toEqual(["pk_eph_key-0", "pk_eph_key-1"]); // retry used the re-minted key
  });

  it("(b) a 401 with a DIFFERENT body is NOT retried", async () => {
    const { fetchImpl } = healingFetch({ fail: 1, body401: { error: "some other 401" } });
    const key = refreshableKey();
    const t = new Transport({ baseUrl: BASE, fetchImpl: fetchImpl as never, pythiaKey: key });
    const res = await t.postJson("/stoachain/send", {});
    expect(res.status).toBe(401);
    expect(key.invalidate).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("(b2) a static-string key (not refreshable) is NEVER retried even on the target 401", async () => {
    const { fetchImpl } = healingFetch({ fail: 1 });
    const t = new Transport({ baseUrl: BASE, fetchImpl: fetchImpl as never, pythiaKey: "pk_live_static" });
    const res = await t.postJson("/stoachain/send", {});
    expect(res.status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("(d) a SECOND consecutive 401 after the retry surfaces the error (no infinite loop)", async () => {
    const { fetchImpl } = healingFetch({ fail: 2 }); // both attempts 401
    const key = refreshableKey();
    const t = new Transport({ baseUrl: BASE, fetchImpl: fetchImpl as never, pythiaKey: key });
    const res = await t.postJson("/stoachain/send", {});
    expect(res.status).toBe(401);
    expect(key.invalidate).toHaveBeenCalledTimes(1); // exactly one re-mint attempt
    expect(fetchImpl).toHaveBeenCalledTimes(2); // original + one retry, then stop
  });
})
