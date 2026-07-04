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

    const parsed = await transport.get("/stoachain/rpc");
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

    const parsed = await transport.postJson("/stoachain/rpc", { a: 1 });
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

    const parsed = await transport.postJson("/stoachain/rpc", { a: 1 });
    expect(parsed.status).toBe(200);
    expect(parsed.body).toEqual({ result: "ok" });
  });
});
