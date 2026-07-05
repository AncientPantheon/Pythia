import { describe, it, expect } from "vitest";
import { blake2b } from "@noble/hashes/blake2b";
import { buildLocalCommand, DEFAULT_READ_GAS_LIMIT } from "./localCommand.js";

/** Recompute base64url(blake2b-256(utf8(cmd))) independently so the test pins
 * the node's own hash-verification rule, not the builder's own arithmetic. */
function expectedHash(cmd: string): string {
  return Buffer.from(blake2b(new TextEncoder().encode(cmd), { dkLen: 32 }))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("buildLocalCommand", () => {
  it("emits a {cmd,hash,sigs} envelope whose hash is the blake2b-256 of the exact cmd bytes", () => {
    // The node rejects any envelope whose hash is not the blake2b digest of the
    // serialized cmd string — so hash MUST be computed over the same bytes sent.
    const envelope = JSON.parse(
      buildLocalCommand("(+ 1 2)", { chainId: 0 }),
    ) as { cmd: string; hash: string; sigs: unknown[] };

    expect(typeof envelope.cmd).toBe("string");
    expect(envelope.hash).toBe(expectedHash(envelope.cmd));
    // Keyless: a /local read is unsigned — sigs is always empty.
    expect(envelope.sigs).toEqual([]);
  });

  it("carries the caller's code, data, chainId and sender into the cmd payload", () => {
    // These four inputs are the only caller-controlled fields; each must land in
    // the exec/meta so the node evaluates exactly the requested read.
    const envelope = JSON.parse(
      buildLocalCommand("(read-thing)", {
        chainId: 3,
        data: { key: "val" },
        sender: "k:abc",
      }),
    ) as { cmd: string };
    const cmd = JSON.parse(envelope.cmd) as {
      networkId: string;
      payload: { exec: { code: string; data: unknown } };
      signers: unknown[];
      meta: { chainId: string; sender: string; gasLimit: number };
    };

    expect(cmd.networkId).toBe("stoa");
    expect(cmd.payload.exec.code).toBe("(read-thing)");
    expect(cmd.payload.exec.data).toEqual({ key: "val" });
    expect(cmd.meta.chainId).toBe("3");
    expect(cmd.meta.sender).toBe("k:abc");
    // Keyless: no signers are ever added by Pythia.
    expect(cmd.signers).toEqual([]);
  });

  it("defaults data to {} and sender to '' when the caller omits them", () => {
    // A bare read needs no data map and no sender; the builder must supply the
    // node-required empty defaults rather than emitting undefined fields.
    const envelope = JSON.parse(buildLocalCommand("(f)", { chainId: 0 })) as {
      cmd: string;
    };
    const cmd = JSON.parse(envelope.cmd) as {
      payload: { exec: { data: unknown } };
      meta: { sender: string };
    };

    expect(cmd.payload.exec.data).toEqual({});
    expect(cmd.meta.sender).toBe("");
  });

  it("defaults meta.gasLimit to DEFAULT_READ_GAS_LIMIT (100M) when the caller omits it", () => {
    // Chainweb /local charges no real gas for an empty sender and accepts any
    // gasLimit; the 100M default lets expensive dirty reads run instead of
    // failing on the old hardcoded 150k budget.
    const cmd = JSON.parse(
      (JSON.parse(buildLocalCommand("(big-read)", { chainId: 0 })) as {
        cmd: string;
      }).cmd,
    ) as { meta: { gasLimit: number } };

    expect(DEFAULT_READ_GAS_LIMIT).toBe(100_000_000);
    expect(cmd.meta.gasLimit).toBe(100_000_000);
  });

  it("puts the caller-supplied gasLimit into meta.gasLimit verbatim", () => {
    // A caller may override the budget per read; the exact integer must land in
    // meta so the node evaluates under the requested ceiling.
    const cmd = JSON.parse(
      (JSON.parse(
        buildLocalCommand("(big-read)", { chainId: 0, gasLimit: 250_000 }),
      ) as { cmd: string }).cmd,
    ) as { meta: { gasLimit: number } };

    expect(cmd.meta.gasLimit).toBe(250_000);
  });
});
