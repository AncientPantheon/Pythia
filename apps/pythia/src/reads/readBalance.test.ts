import { describe, it, expect, vi } from "vitest";
import { blake2b } from "@noble/hashes/blake2b";
import { readBalance } from "./readBalance.js";
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

const ADDRESS = "k:abc123";

/** A chainweb /local success envelope carrying a Pact decimal result. */
function localOk(decimal: string): Response {
  return new Response(
    JSON.stringify({ result: { status: "success", data: { decimal } } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * Route each /local read to a supply keyed by which Pact module the request
 * body names, so the composite can be asserted field-by-field. The body is
 * JSON with the Pact code embedded, so match on the module/token substrings
 * (present regardless of JSON quote-escaping).
 */
function supplyByExpression(bodyText: string): string {
  if (bodyText.includes("DALOS.UR_DISPOSupply")) return "12.5";
  if (bodyText.includes("TFT.URC_VirtualOuro")) return "3.25";
  if (bodyText.includes("GAS-8Nh-JO8JO4F5")) return "0.001";
  // Any other DPTF.UR_AccountSupply is the optional arbitrary token read.
  return "777.7";
}

/** The chainweb command-envelope shape POSTed to /local. */
interface LocalEnvelope {
  cmd: string;
  hash: string;
  sigs: unknown[];
}

/** Decode the Pact code back out of a captured /local envelope request body. */
function codeOf(bodyText: string): string {
  const envelope = JSON.parse(bodyText) as LocalEnvelope;
  const payload = JSON.parse(envelope.cmd) as {
    payload: { exec: { code: string } };
  };
  return payload.payload.exec.code;
}

/** Recompute the base64url blake2b-256 of a cmd string — the node's own check. */
function expectedHash(cmd: string): string {
  const digest = blake2b(new TextEncoder().encode(cmd), { dkLen: 32 });
  return Buffer.from(digest)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("readBalance composite decode", () => {
  it("returns the decoded IGNIS / OURO-dispo / virtual-OURO picture as strings", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      localOk(supplyByExpression(String(init?.body))),
    );

    const result = await readBalance(
      { address: ADDRESS },
      { primary, fallback, fetchImpl: fetchImpl as never },
    );

    // Each field is the decoded decimal STRING for its Pact expression — driven
    // by which module the request named, not a hardcoded constant.
    expect(result).toEqual({
      chain: "stoachain",
      address: ADDRESS,
      ignis: "0.001",
      ouroDispo: "12.5",
      virtualOuro: "3.25",
    });
    // No `token` key when none was requested.
    expect(result.token).toBeUndefined();
  });

  it("issues the exact reused Pact expressions to the /local endpoint", async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      expect(url).toBe(
        "https://primary.example/chainweb/0.0/stoa/chain/0/pact/api/v1/local",
      );
      return localOk(supplyByExpression(String(init?.body)));
    });

    await readBalance(
      { address: ADDRESS },
      { primary, fallback, fetchImpl: fetchImpl as never },
    );

    const codes = bodies.map(codeOf);
    // The verbatim reused expressions with the replicated namespace + IGNIS id.
    expect(codes).toContain(
      `(ouronet-ns.DPTF.UR_AccountSupply "GAS-8Nh-JO8JO4F5" "${ADDRESS}")`,
    );
    expect(codes).toContain(`(ouronet-ns.DALOS.UR_DISPOSupply "${ADDRESS}")`);
    expect(codes).toContain(`(ouronet-ns.TFT.URC_VirtualOuro "${ADDRESS}")`);
  });

  it("POSTs a valid, hash-matching Pact command envelope the node can verify", async () => {
    // The showstopper this guards: chainweb /local cryptographically verifies
    // that `hash` is the base64url blake2b-256 of the `cmd` string, and rejects
    // a bare {exec,meta} body with `key "cmd" not found`. Assert the full
    // envelope shape AND recompute the hash so a wrong body/hash fails here.
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return localOk(supplyByExpression(String(init?.body)));
    });

    await readBalance(
      { address: ADDRESS },
      { primary, fallback, fetchImpl: fetchImpl as never },
    );

    for (const bodyText of bodies) {
      const envelope = JSON.parse(bodyText) as LocalEnvelope;
      // Envelope keys the node requires, with an empty sig list (read, unsigned).
      expect(Object.keys(envelope).sort()).toEqual(["cmd", "hash", "sigs"]);
      expect(envelope.sigs).toEqual([]);
      expect(typeof envelope.cmd).toBe("string");

      // The cmd is a stringified Pact command payload with the read wiring.
      const payload = JSON.parse(envelope.cmd) as {
        networkId: string;
        payload: { exec: { code: string; data: Record<string, unknown> } };
        signers: unknown[];
        meta: { chainId: string; sender: string };
        nonce: string;
      };
      expect(payload.networkId).toBe("stoa");
      expect(payload.meta.chainId).toBe("0");
      expect(payload.signers).toEqual([]);
      expect(payload.payload.exec.data).toEqual({});
      expect(payload.payload.exec.code).toMatch(/UR_AccountSupply|UR_DISPOSupply|URC_VirtualOuro/);

      // The node verifies hash === base64url(blake2b-256(cmd)); recompute it.
      expect(envelope.hash).toBe(expectedHash(envelope.cmd));
    }
  });

  it("decodes a legitimate no-balance read to \"0\" (distinct from a failure)", async () => {
    // A zero/absent balance is a real answer, not an error — it must surface as
    // the string "0", never as null and never as a pool-exhausted error.
    const fetchImpl = vi.fn(async () => localOk("0"));

    const result = await readBalance(
      { address: ADDRESS },
      { primary, fallback, fetchImpl: fetchImpl as never },
    );

    expect(result.ignis).toBe("0");
    expect(result.ouroDispo).toBe("0");
    expect(result.virtualOuro).toBe("0");
  });

  it("resolves the optional arbitrary DPTF token supply as { id, supply }", async () => {
    const TOKEN = "AURYN-8Nh-JO8JO4F5";
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return localOk(supplyByExpression(String(init?.body)));
    });

    const result = await readBalance(
      { address: ADDRESS, token: TOKEN },
      { primary, fallback, fetchImpl: fetchImpl as never },
    );

    expect(result.token).toEqual({ id: TOKEN, supply: "777.7" });
    // The arbitrary token read used the same UR_AccountSupply expression with
    // the caller's token id, not the hardcoded IGNIS id.
    expect(bodies.map(codeOf)).toContain(
      `(ouronet-ns.DPTF.UR_AccountSupply "${TOKEN}" "${ADDRESS}")`,
    );
  });

  it("returns a valid composite via the FALLBACK when the primary fails transport", async () => {
    // A transient primary outage must not fail the read — dial() fails over to
    // the fallback per sub-read and the composite still resolves fully.
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://primary.example")) {
        throw new TypeError("primary down");
      }
      return localOk(supplyByExpression(String(init?.body)));
    });

    const result = await readBalance(
      { address: ADDRESS },
      { primary, fallback, fetchImpl: fetchImpl as never },
    );

    expect(result.ouroDispo).toBe("12.5");
    expect(result.virtualOuro).toBe("3.25");
  });

  it("surfaces PythiaPoolExhaustedError when BOTH hosts are down (never null)", async () => {
    // A both-hosts-down sub-read must reject the whole composite with the
    // terminal transport error — the sibling wrappers' catch→null contract is
    // explicitly NOT adopted, so a transport failure is never hidden as "0".
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("all down");
    });

    await expect(
      readBalance(
        { address: ADDRESS },
        { primary, fallback, fetchImpl: fetchImpl as never },
      ),
    ).rejects.toBeInstanceOf(PythiaPoolExhaustedError);
  });

  it("rejects an empty address with PythiaValidationError and issues NO fetch", async () => {
    const fetchImpl = vi.fn(async () => localOk("1"));

    await expect(
      readBalance(
        { address: "" },
        { primary, fallback, fetchImpl: fetchImpl as never },
      ),
    ).rejects.toBeInstanceOf(PythiaValidationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("raises PythiaUpstreamError (not a SyntaxError) when a /local read returns a 400 plain-text body", async () => {
    // A malformed address makes the node reject with 400 + plain text. The
    // composite read must surface the TYPED upstream error, never crash on
    // .json() of a non-JSON body.
    const fetchImpl = vi.fn(async () =>
      new Response("Error: invalid account format", {
        status: 400,
        headers: { "content-type": "text/plain" },
      }),
    );

    const err = await readBalance(
      { address: ADDRESS },
      { primary, fallback, fetchImpl: fetchImpl as never },
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(PythiaUpstreamError);
    expect((err as PythiaUpstreamError).status).toBe(400);
  });

  it("raises PythiaUpstreamError with a 5xx status when a /local read returns a server error", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("backend unavailable", { status: 503 }),
    );

    const err = await readBalance(
      { address: ADDRESS },
      { primary, fallback, fetchImpl: fetchImpl as never },
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(PythiaUpstreamError);
    expect((err as PythiaUpstreamError).status).toBe(503);
  });

  it("raises PythiaUpstreamError when a /local 200 body is not valid JSON", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("<html>proxy error</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const err = await readBalance(
      { address: ADDRESS },
      { primary, fallback, fetchImpl: fetchImpl as never },
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(PythiaUpstreamError);
    expect((err as PythiaUpstreamError).status).toBe(200);
  });

  it("still decodes an ok /local eval-failure envelope to \"0\" (Pact non-success is not an upstream error)", async () => {
    // Guard the boundary: a 200 success envelope whose Pact result.status is NOT
    // "success" remains a legitimate no-balance "0", NOT an upstream error.
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ result: { status: "failure" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await readBalance(
      { address: ADDRESS },
      { primary, fallback, fetchImpl: fetchImpl as never },
    );

    expect(result.ignis).toBe("0");
    expect(result.ouroDispo).toBe("0");
    expect(result.virtualOuro).toBe("0");
  });
});
