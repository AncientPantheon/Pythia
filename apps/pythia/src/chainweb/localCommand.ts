import { blake2b } from "@noble/hashes/blake2b";
import { STOA_NETWORK } from "../dial/index.js";

export interface LocalCommandOptions {
  /** Chainweb chain the read targets (0-9). */
  chainId: number;
  /** Optional Pact `data` map made available to the read code. Defaults to `{}`. */
  data?: object;
  /** Optional sender account recorded in `meta`. Defaults to `""`. */
  sender?: string;
}

/** base64url = standard base64 with +→-, /→_, trailing = stripped. */
function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Wrap a Pact expression as a full chainweb `/local` command envelope
 * `{cmd, hash, sigs}`. The node REQUIRES this envelope (a bare `{exec,meta}`
 * body is rejected with `key "cmd" not found`) and cryptographically verifies
 * that `hash` is the base64url blake2b-256 of the exact `cmd` string — so the
 * hash is computed over the same serialized bytes that are sent. `sigs` is
 * empty and `signers` is empty: a `/local` read is unsigned. Keyless — Pythia
 * adds no key material and signs nothing; blake2b here is a pure content digest,
 * not transaction signing.
 */
export function buildLocalCommand(
  code: string,
  options: LocalCommandOptions,
): string {
  const cmdPayload = {
    networkId: STOA_NETWORK,
    payload: { exec: { code, data: options.data ?? {} } },
    signers: [],
    meta: {
      chainId: String(options.chainId),
      sender: options.sender ?? "",
      gasLimit: 150000,
      gasPrice: 0.00000001,
      ttl: 600,
      creationTime: Math.floor(Date.now() / 1000),
    },
    nonce: "pythia",
  };
  const cmd = JSON.stringify(cmdPayload);
  const hash = base64url(blake2b(new TextEncoder().encode(cmd), { dkLen: 32 }));
  return JSON.stringify({ cmd, hash, sigs: [] });
}
