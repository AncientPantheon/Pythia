import { describe, it, expect } from "vitest";
import { probeNodes } from "./probeNodes.js";

/** Build a fetchImpl that resolves/rejects per-url, so we drive each reason branch. */
function fetchWith(map: Record<string, () => Promise<Response>>) {
  return ((url: string) => {
    const host = url.replace(/\/info$/, "");
    const h = map[host];
    if (!h) throw new Error(`unexpected url ${url}`);
    return h();
  }) as unknown as typeof fetch;
}

function causeErr(code: string): Error {
  const e = new TypeError("fetch failed");
  (e as unknown as { cause: { code: string } }).cause = { code };
  return e;
}

describe("probeNodes", () => {
  it("marks a 2xx node reachable with a null reason", async () => {
    const fetchImpl = fetchWith({
      "https://ok.test": async () => new Response("{}", { status: 200 }),
    });
    const [r] = await probeNodes(["https://ok.test"], { fetchImpl });
    expect(r).toEqual({ url: "https://ok.test", reachable: true, reason: null });
  });

  it("reports a non-2xx as http <status>", async () => {
    const fetchImpl = fetchWith({
      "https://redir.test": async () => new Response("", { status: 308 }),
    });
    const [r] = await probeNodes(["https://redir.test"], { fetchImpl });
    expect(r).toMatchObject({ reachable: false, reason: "http 308" });
  });

  it("classifies an abort as timeout (real DOMException shape, NOT instanceof Error)", async () => {
    // Node's fetch rejects an aborted request with a DOMException — which is not
    // `instanceof Error`. A plain Error stub would hide the misclassification.
    const fetchImpl = fetchWith({
      "https://slow.test": async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    });
    const [r] = await probeNodes(["https://slow.test"], { fetchImpl });
    expect(r).toMatchObject({ reachable: false, reason: "timeout" });
  });

  it("classifies a connect-timeout code as timeout and an unknown code as unreachable", async () => {
    const fetchImpl = fetchWith({
      "https://ct.test": async () => Promise.reject(causeErr("UND_ERR_CONNECT_TIMEOUT")),
      "https://weird.test": async () => Promise.reject(causeErr("EHOSTUNREACH")),
    });
    const res = await probeNodes(["https://ct.test", "https://weird.test"], { fetchImpl });
    const by = Object.fromEntries(res.map((r) => [r.url, r.reason]));
    expect(by["https://ct.test"]).toBe("timeout");
    expect(by["https://weird.test"]).toBe("unreachable");
  });

  it("classifies ECONNREFUSED as refused, ENOTFOUND as dns, and a TLS cert code as cert", async () => {
    const fetchImpl = fetchWith({
      "https://refused.test": async () => Promise.reject(causeErr("ECONNREFUSED")),
      "https://nodns.test": async () => Promise.reject(causeErr("ENOTFOUND")),
      "https://badcert.test": async () => Promise.reject(causeErr("ERR_TLS_CERT_ALTNAME_INVALID")),
    });
    const res = await probeNodes(
      ["https://refused.test", "https://nodns.test", "https://badcert.test"],
      { fetchImpl },
    );
    const by = Object.fromEntries(res.map((r) => [r.url, r.reason]));
    expect(by["https://refused.test"]).toBe("refused");
    expect(by["https://nodns.test"]).toBe("dns");
    expect(by["https://badcert.test"]).toBe("cert");
  });

  it("probes /info and returns one result per url in order", async () => {
    let hit = "";
    const fetchImpl = ((url: string) => {
      hit = url;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;
    const res = await probeNodes(["https://a.test"], { fetchImpl });
    expect(hit).toBe("https://a.test/info");
    expect(res).toHaveLength(1);
  });
});
