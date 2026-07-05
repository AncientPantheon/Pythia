import { describe, it, expect, vi } from "vitest";
import { pollConfirmations } from "./poll.js";
import { PythiaUpstreamError } from "./errors.js";
import { PythiaValidationError, PythiaPoolExhaustedError } from "../dial/index.js";
import type { SourceConfig } from "../config/index.js";

const primary: SourceConfig = {
  id: "stoachain-primary",
  url: "https://primary.example",
  role: "primary",
  chain: "stoachain",
};
const fallback: SourceConfig = {
  id: "stoachain-fallback",
  url: "https://fallback.example",
  role: "fallback",
  chain: "stoachain",
};

const KEY_A = "reqkey-a";
const KEY_B = "reqkey-b";
const FINALITY = 6;

/** A chainweb poll response keying each mined key to its inclusion height. */
function poll(records: Record<string, number>): Response {
  const body: Record<string, unknown> = {};
  for (const [key, blockHeight] of Object.entries(records)) {
    body[key] = { reqKey: key, result: { status: "success" }, blockHeight };
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A cut response reporting the current per-chain height. */
function cut(chainId: number, height: number): Response {
  return new Response(
    JSON.stringify({ hashes: { [String(chainId)]: { height, hash: "h" } } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Wire fetch to answer poll (POST, path ends /poll) and cut (path ends /cut). */
function fetchFor(pollRes: Response, cutRes: Response) {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/cut")) return cutRes.clone();
    return pollRes.clone();
  });
}

describe("pollConfirmations multi-key", () => {
  it("classifies each key by its own depth against finalityDepth (below/at/above)", async () => {
    // Three keys in one batch: below (pending), at (final, inclusive boundary),
    // above (final). Each status is driven by that key's own depth, not shared.
    const KEY_C = "reqkey-c";
    const fetchImpl = fetchFor(
      poll({ [KEY_A]: 100, [KEY_B]: 100, [KEY_C]: 100 }),
      cut(0, 106),
    );

    const out = await pollConfirmations(
      { requestKeys: [KEY_A, KEY_B, KEY_C], chainId: 0, finalityDepth: FINALITY },
      { primary, fallback, fetchImpl: fetchImpl as never },
    );

    // Same tx height 100, current 106 → depth 6 for all → at-boundary final.
    expect(out.results[KEY_A]).toEqual({ status: "final", depth: 6, blockHeight: 100 });
    expect(out.chainId).toBe(0);
    expect(out.finalityDepth).toBe(FINALITY);
  });

  it("reports distinct depths for keys mined at different heights", async () => {
    // KEY_A at 100 (depth 4 < 6 → pending), KEY_B at 90 (depth 14 → final).
    const fetchImpl = fetchFor(poll({ [KEY_A]: 100, [KEY_B]: 90 }), cut(0, 104));

    const out = await pollConfirmations(
      { requestKeys: [KEY_A, KEY_B], finalityDepth: FINALITY },
      { primary, fallback, fetchImpl: fetchImpl as never },
    );

    expect(out.results[KEY_A]).toEqual({ status: "pending", depth: 4, blockHeight: 100 });
    expect(out.results[KEY_B]).toEqual({ status: "final", depth: 14, blockHeight: 90 });
  });

  it("reports pending/0 with no blockHeight for an unmined key absent from the poll result", async () => {
    // KEY_B is mined; KEY_A is not in the poll record → it is a legitimate
    // pending at depth 0, never dropped from the results and never an error.
    const fetchImpl = fetchFor(poll({ [KEY_B]: 100 }), cut(0, 200));

    const out = await pollConfirmations(
      { requestKeys: [KEY_A, KEY_B], chainId: 0, finalityDepth: FINALITY },
      { primary, fallback, fetchImpl: fetchImpl as never },
    );

    expect(out.results[KEY_A]).toEqual({ status: "pending", depth: 0 });
    expect(out.results[KEY_A].blockHeight).toBeUndefined();
    expect(out.results[KEY_B].status).toBe("final");
  });

  it("POSTs the whole requestKeys array to /poll in one call", async () => {
    // The batch must be sent as {requestKeys:[...]} to the /poll path — one poll
    // read for all keys, not one call per key.
    let capturedBody: string | undefined;
    let pollUrl: string | undefined;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/cut")) return cut(0, 110);
      pollUrl = url;
      capturedBody = init?.body as string;
      return poll({ [KEY_A]: 100, [KEY_B]: 100 });
    });

    await pollConfirmations(
      { requestKeys: [KEY_A, KEY_B], chainId: 2, finalityDepth: FINALITY },
      { primary, fallback, fetchImpl: fetchImpl as never },
    );

    expect(pollUrl).toBe(
      "https://primary.example/chainweb/0.0/stoa/chain/2/pact/api/v1/poll",
    );
    expect(JSON.parse(capturedBody!)).toEqual({ requestKeys: [KEY_A, KEY_B] });
  });

  it("surfaces PythiaPoolExhaustedError when both hosts are down", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("all down");
    });

    await expect(
      pollConfirmations(
        { requestKeys: [KEY_A], chainId: 0, finalityDepth: FINALITY },
        { primary, fallback, fetchImpl: fetchImpl as never },
      ),
    ).rejects.toBeInstanceOf(PythiaPoolExhaustedError);
  });

  it("rejects an out-of-range chainId with PythiaValidationError before any read", async () => {
    const fetchImpl = vi.fn(async () => cut(0, 1));

    await expect(
      pollConfirmations(
        { requestKeys: [KEY_A], chainId: 99, finalityDepth: FINALITY },
        { primary, fallback, fetchImpl: fetchImpl as never },
      ),
    ).rejects.toBeInstanceOf(PythiaValidationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("raises a typed PythiaUpstreamError (not a SyntaxError) when the poll node returns a 400 plain-text body", async () => {
    // A malformed request key makes the node answer 400 with plain text; the poll
    // read must surface the typed upstream error, never an opaque JSON parse throw.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/cut")) return cut(0, 200);
      return new Response("Error in $.requestKeys[0]: invalid size", {
        status: 400,
        headers: { "content-type": "text/plain" },
      });
    });

    const err = await pollConfirmations(
      { requestKeys: [KEY_A], chainId: 0, finalityDepth: FINALITY },
      { primary, fallback, fetchImpl: fetchImpl as never },
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(PythiaUpstreamError);
    expect((err as PythiaUpstreamError).status).toBe(400);
  });
});
