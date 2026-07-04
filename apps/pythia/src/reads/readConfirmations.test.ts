import { describe, it, expect, vi } from "vitest";
import { readConfirmations } from "./readConfirmations.js";
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

const TX = "requestkey-abc";
const FINALITY = 6;

/** A chainweb poll response keying the tx to its inclusion block height. */
function pollMined(txHeight: number): Response {
  return new Response(
    JSON.stringify({ [TX]: { reqKey: TX, result: { status: "success" }, blockHeight: txHeight } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** An empty poll response — the tx is not yet mined. */
function pollEmpty(): Response {
  return new Response(JSON.stringify({}), {
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

/**
 * Wire fetch to answer the poll and cut reads distinctly. The poll path ends in
 * `/poll`; the cut path ends in `/cut`.
 */
function fetchFor(pollRes: Response, cutRes: Response) {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/cut")) return cutRes.clone();
    return pollRes.clone();
  });
}

describe("readConfirmations decode", () => {
  it("reports pending when depth is BELOW finalityDepth", async () => {
    // tx at height 100, current 104 → depth 4 < 6 → pending. Depth is the
    // decision driver, computed from the two reads, not a fixed value.
    const fetchImpl = fetchFor(pollMined(100), cut(0, 104));

    const result = await readConfirmations(
      { tx: TX, chainId: 0, finalityDepth: FINALITY },
      { primary, fallback, fetchImpl: fetchImpl as never },
    );

    expect(result.status).toBe("pending");
    expect(result.depth).toBe(4);
    expect(result.blockHeight).toBe(100);
    expect(result.finalityDepth).toBe(FINALITY);
    expect(result.chain).toBe("stoachain");
    expect(result.tx).toBe(TX);
    expect(result.chainId).toBe(0);
  });

  it("reports final when depth EQUALS finalityDepth (boundary is inclusive)", async () => {
    // tx at 100, current 106 → depth 6 === finalityDepth → final. The boundary
    // must be inclusive; an off-by-one here would wrongly hold a final tx.
    const fetchImpl = fetchFor(pollMined(100), cut(0, 106));

    const result = await readConfirmations(
      { tx: TX, chainId: 0, finalityDepth: FINALITY },
      { primary, fallback, fetchImpl: fetchImpl as never },
    );

    expect(result.depth).toBe(6);
    expect(result.status).toBe("final");
  });

  it("reports final when depth is ABOVE finalityDepth", async () => {
    const fetchImpl = fetchFor(pollMined(100), cut(0, 120));

    const result = await readConfirmations(
      { tx: TX, chainId: 0, finalityDepth: FINALITY },
      { primary, fallback, fetchImpl: fetchImpl as never },
    );

    expect(result.depth).toBe(20);
    expect(result.status).toBe("final");
  });

  it("reports pending at depth 0 with no blockHeight for an unmined tx", async () => {
    // An empty poll result means the tx is not yet in a block — that is a
    // legitimate pending state (depth 0), NOT an error.
    const fetchImpl = fetchFor(pollEmpty(), cut(0, 200));

    const result = await readConfirmations(
      { tx: TX, chainId: 0, finalityDepth: FINALITY },
      { primary, fallback, fetchImpl: fetchImpl as never },
    );

    expect(result.status).toBe("pending");
    expect(result.depth).toBe(0);
    expect(result.blockHeight).toBeUndefined();
  });

  it("defaults chainId to 0 and reads its height from the cut", async () => {
    let cutRequested = false;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/cut")) {
        cutRequested = true;
        return cut(0, 110);
      }
      return pollMined(100);
    });

    const result = await readConfirmations(
      { tx: TX, finalityDepth: FINALITY },
      { primary, fallback, fetchImpl: fetchImpl as never },
    );

    expect(cutRequested).toBe(true);
    expect(result.chainId).toBe(0);
    expect(result.depth).toBe(10);
  });

  it("returns a valid status via the FALLBACK when the primary fails transport", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://primary.example")) {
        throw new TypeError("primary down");
      }
      if (url.endsWith("/cut")) return cut(0, 106);
      return pollMined(100);
    });

    const result = await readConfirmations(
      { tx: TX, chainId: 0, finalityDepth: FINALITY },
      { primary, fallback, fetchImpl: fetchImpl as never },
    );

    expect(result.status).toBe("final");
    expect(result.depth).toBe(6);
  });

  it("surfaces PythiaPoolExhaustedError when both hosts are down", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("all down");
    });

    await expect(
      readConfirmations(
        { tx: TX, chainId: 0, finalityDepth: FINALITY },
        { primary, fallback, fetchImpl: fetchImpl as never },
      ),
    ).rejects.toBeInstanceOf(PythiaPoolExhaustedError);
  });

  it("rejects an empty tx with PythiaValidationError and issues NO fetch", async () => {
    const fetchImpl = vi.fn(async () => cut(0, 1));

    await expect(
      readConfirmations(
        { tx: "", chainId: 0, finalityDepth: FINALITY },
        { primary, fallback, fetchImpl: fetchImpl as never },
      ),
    ).rejects.toBeInstanceOf(PythiaValidationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range chainId with PythiaValidationError before any read", async () => {
    const fetchImpl = vi.fn(async () => cut(0, 1));

    await expect(
      readConfirmations(
        { tx: TX, chainId: 99, finalityDepth: FINALITY },
        { primary, fallback, fetchImpl: fetchImpl as never },
      ),
    ).rejects.toBeInstanceOf(PythiaValidationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("raises PythiaUpstreamError (not a SyntaxError) when the poll node returns a 400 plain-text body", async () => {
    // The LIVE crash: a malformed request key makes the node answer 400 with a
    // PLAIN-TEXT body. The poll read must surface a TYPED upstream error carrying
    // the 4xx status, never throw an opaque SyntaxError from .json().
    const bodyText =
      "Error in $.requestKeys[0]: Base64-encoded bytestring has invalid size";
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/cut")) return cut(0, 200);
      return new Response(bodyText, {
        status: 400,
        headers: { "content-type": "text/plain" },
      });
    });

    const err = await readConfirmations(
      { tx: TX, chainId: 0, finalityDepth: FINALITY },
      { primary, fallback, fetchImpl: fetchImpl as never },
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(PythiaUpstreamError);
    expect((err as PythiaUpstreamError).status).toBe(400);
    expect((err as PythiaUpstreamError).message).toContain("invalid size");
  });

  it("raises PythiaUpstreamError with a 5xx status when the cut node returns a server error", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/cut")) {
        return new Response("cut backend down", { status: 502 });
      }
      return pollMined(100);
    });

    const err = await readConfirmations(
      { tx: TX, chainId: 0, finalityDepth: FINALITY },
      { primary, fallback, fetchImpl: fetchImpl as never },
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(PythiaUpstreamError);
    expect((err as PythiaUpstreamError).status).toBe(502);
  });

  it("raises PythiaUpstreamError when a poll 200 body is not valid JSON", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/cut")) return cut(0, 200);
      return new Response("<html>gateway</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });

    const err = await readConfirmations(
      { tx: TX, chainId: 0, finalityDepth: FINALITY },
      { primary, fallback, fetchImpl: fetchImpl as never },
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(PythiaUpstreamError);
    expect((err as PythiaUpstreamError).status).toBe(200);
  });
});
