import { describe, it, expect } from "vitest";
import { readJson } from "./readJson.js";
import { PythiaUpstreamError } from "./errors.js";

const SOURCE = "https://primary.example/chainweb/0.0/stoa/chain/0/pact/api/v1/poll";

describe("readJson upstream-response guard", () => {
  it("parses and returns the JSON body of an ok response", async () => {
    // The happy path stays a plain parse — an ok JSON body decodes to its value
    // so the existing 200-{}/pending and no-balance reads are untouched.
    const response = new Response(JSON.stringify({ key: { blockHeight: 42 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const parsed = (await readJson(response, SOURCE)) as {
      key: { blockHeight: number };
    };

    expect(parsed.key.blockHeight).toBe(42);
  });

  it("returns the empty object for a 200 {} without treating it as an error", async () => {
    // A valid-format but unknown request key arrives as 200 {} — this MUST stay
    // a plain parse (the pending/depth-0 path), never an upstream error.
    const response = new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const parsed = (await readJson(response, SOURCE)) as Record<string, unknown>;

    expect(parsed).toEqual({});
  });

  it("throws PythiaUpstreamError carrying the 4xx status and plain-text snippet for a non-ok response", async () => {
    // The LIVE-observed malformed-tx case: node returns 400 + PLAIN TEXT (not
    // JSON). readJson must NOT call .json() on it (which would SyntaxError); it
    // reads the body as text and raises a typed error with the status + snippet.
    const bodyText =
      "Error in $.requestKeys[0]: Base64-encoded bytestring has invalid size";
    const response = new Response(bodyText, {
      status: 400,
      headers: { "content-type": "text/plain" },
    });

    const err = await readJson(response, SOURCE).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(PythiaUpstreamError);
    const upstream = err as PythiaUpstreamError;
    expect(upstream.status).toBe(400);
    expect(upstream.message).toContain("invalid size");
    expect(upstream.source).toBe(SOURCE);
    expect(upstream.name).toBe("PythiaUpstreamError");
  });

  it("throws PythiaUpstreamError with the 5xx status for an upstream server error", async () => {
    const response = new Response("upstream boom", {
      status: 503,
      headers: { "content-type": "text/plain" },
    });

    const err = await readJson(response, SOURCE).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(PythiaUpstreamError);
    expect((err as PythiaUpstreamError).status).toBe(503);
  });

  it("throws PythiaUpstreamError when an ok response body is NOT valid JSON", async () => {
    // A 200 with a non-JSON body would crash the old code with a SyntaxError.
    // readJson catches the parse failure and surfaces a typed error carrying the
    // arrived status (200) so the route can map it to a 502 "upstream error".
    const response = new Response("<html>not json</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });

    const err = await readJson(response, SOURCE).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(PythiaUpstreamError);
    expect((err as PythiaUpstreamError).status).toBe(200);
    expect((err as PythiaUpstreamError).source).toBe(SOURCE);
  });
});
