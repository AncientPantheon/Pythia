import { blake2b } from "@noble/hashes/blake2b";
import { mayComeWithDeimal } from "@stoachain/stoa-core/pact";
import { dial, STOA_NETWORK, type FetchImpl } from "../dial/index.js";
import type { SourceConfig } from "../config/index.js";
import { requirePactSafe } from "./validate.js";
import { readJson } from "./readJson.js";
import { KADENA_NAMESPACE, TOKEN_ID_IGNIS } from "./constants.js";

export interface ReadBalanceInput {
  address: string;
  /** Optional arbitrary DPTF token id to also resolve alongside the core three. */
  token?: string;
}

export interface ReadBalanceDeps {
  primary: SourceConfig;
  fallback: SourceConfig;
  fetchImpl?: FetchImpl;
}

export interface Balance {
  chain: "stoachain";
  address: string;
  ignis: string;
  ouroDispo: string;
  virtualOuro: string;
  token?: { id: string; supply: string };
}

/** The chainweb chain the composite balance reads target (Stoa chain 0). */
const READ_CHAIN_ID = 0;

/** Shape of a chainweb /local read response envelope we decode. */
interface LocalReadResponse {
  result?: { status?: string; data?: unknown };
}

function localReadPath(host: string): string {
  return `${host}/chainweb/0.0/${STOA_NETWORK}/chain/${READ_CHAIN_ID}/pact/api/v1/local`;
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
 * empty: a `/local` read is unsigned. blake2b here hashes a read payload; it is
 * a pure content digest, not transaction signing.
 */
function buildLocalCommand(code: string): string {
  const cmdPayload = {
    networkId: STOA_NETWORK,
    payload: { exec: { code, data: {} } },
    signers: [],
    meta: {
      chainId: String(READ_CHAIN_ID),
      sender: "",
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

/**
 * Issue one /local Pact read over the shared dial() and decode the result. On
 * `result.status === "success"` the data is unwrapped by `mayComeWithDeimal`
 * (a clean, zero-import decoder) into its decimal STRING — never round-tripped
 * through a JS float. A both-hosts-down read propagates PythiaPoolExhaustedError
 * from dial(); it is NEVER swallowed to a null/"0", so a transport failure stays
 * distinct from a legitimate zero balance.
 */
async function readSupply(
  code: string,
  deps: ReadBalanceDeps,
): Promise<string> {
  const response = await dial(
    {
      chainId: READ_CHAIN_ID,
      buildRequest: (host) => [
        localReadPath(host),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: buildLocalCommand(code),
        },
      ],
    },
    { primary: deps.primary, fallback: deps.fallback, fetchImpl: deps.fetchImpl },
  );

  const envelope = (await readJson(
    response,
    localReadPath(deps.primary.url),
  )) as LocalReadResponse;
  if (envelope.result?.status === "success") {
    return String(mayComeWithDeimal(envelope.result.data));
  }
  // A node-arrived non-success (e.g. a Pact eval failure) is a legitimate
  // "no balance for this account" answer for these supply reads → "0", distinct
  // from a transport failure (which already threw above).
  return "0";
}

const ignisExpr = (address: string): string =>
  `(${KADENA_NAMESPACE}.DPTF.UR_AccountSupply "${TOKEN_ID_IGNIS}" "${address}")`;
const ouroDispoExpr = (address: string): string =>
  `(${KADENA_NAMESPACE}.DALOS.UR_DISPOSupply "${address}")`;
const virtualOuroExpr = (address: string): string =>
  `(${KADENA_NAMESPACE}.TFT.URC_VirtualOuro "${address}")`;
const tokenExpr = (tokenId: string, address: string): string =>
  `(${KADENA_NAMESPACE}.DPTF.UR_AccountSupply "${tokenId}" "${address}")`;

/**
 * Read the composite normalized balance for an address over Pythia's own dial()
 * failover loop: IGNIS (gas), OURO dispo, virtual OURO, and — when a `token` id
 * is given — an arbitrary DPTF supply. Each sub-read is an independent /local
 * Pact read decoded to a decimal STRING; the reads run concurrently and each
 * fails over per-host. A both-hosts-down sub-read rejects the whole composite
 * with PythiaPoolExhaustedError (a partial composite would hide a transport
 * failure). An empty `address` throws PythiaValidationError BEFORE any read.
 */
export async function readBalance(
  input: ReadBalanceInput,
  deps: ReadBalanceDeps,
): Promise<Balance> {
  // Both the address and the optional token id are interpolated into Pact
  // string literals, so each must clear the Pact-safe allowlist BEFORE any expr
  // is built — a break-out value (`"`, `\`, `(`) is rejected here, never sent.
  const address = requirePactSafe(input.address, "address");
  const token =
    input.token !== undefined ? requirePactSafe(input.token, "token") : undefined;

  const [ignis, ouroDispo, virtualOuro, tokenSupply] = await Promise.all([
    readSupply(ignisExpr(address), deps),
    readSupply(ouroDispoExpr(address), deps),
    readSupply(virtualOuroExpr(address), deps),
    token !== undefined
      ? readSupply(tokenExpr(token, address), deps)
      : Promise.resolve(undefined),
  ]);

  const balance: Balance = {
    chain: "stoachain",
    address,
    ignis,
    ouroDispo,
    virtualOuro,
  };
  if (token !== undefined && tokenSupply !== undefined) {
    balance.token = { id: token, supply: tokenSupply };
  }
  return balance;
}
