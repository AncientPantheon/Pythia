import { dial, STOA_NETWORK, type DialNode, type FetchImpl } from "../../dial/index.js";
import { buildLocalCommand } from "../../chainweb/localCommand.js";

/** The namespace + module the PYTHIA consumer-key reads live in. */
const PYTHIA_NS = "ouronet-ns";

/** The {primary, fallback} nodes to read the trust anchor from. */
export interface ReadPair {
  primary: DialNode;
  fallback: DialNode;
}

function localReadPath(host: string, chainId: number): string {
  return `${host}/chainweb/0.0/${STOA_NETWORK}/chain/${chainId}/pact/api/v1/local`;
}

/**
 * Read a half's IMMUTABLE Apollo public key from chain via
 * `(ouronet-ns.PYTHIA.UR_Public (read-string "acct"))`.
 *
 * This is the TRUST ANCHOR of verification: Pythia reads the key ITSELF and never
 * trusts a caller-supplied key. The account is passed via env-`data` (NOT inlined
 * into the Pact code) so it can't inject. A keyless dirty read. Returns the `6g.…`
 * public-key string, or `null` if the half has no on-chain key / the read failed.
 *
 * The caller supplies the {@link ReadPair} — for verification the route pins it to
 * the operator's OWN Upload-Pool nodes rather than the open, externally-fed hub
 * rotation, so a single dishonest hub-advertised node can't forge the pubkey (and
 * thus forge ownership). NOTE: this is still a single-node read with no quorum/SPV;
 * before the on-chain Link tx is wired, harden to N-of-M agreement or an SPV proof.
 */
export async function readApolloPublicKey(
  pair: ReadPair,
  account: string,
  opts: { chainId?: number; fetchImpl?: FetchImpl } = {},
): Promise<string | null> {
  const chainId = opts.chainId ?? 0;
  const body = buildLocalCommand(
    `(${PYTHIA_NS}.PYTHIA.UR_Public (read-string "acct"))`,
    { chainId, data: { acct: account } },
  );

  let json: { result?: { status?: string; data?: unknown } } | null;
  try {
    const res = await dial(
      {
        chainId,
        buildRequest: (host) => [
          localReadPath(host, chainId),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          },
        ],
      },
      { primary: pair.primary, fallback: pair.fallback, fetchImpl: opts.fetchImpl },
    );
    json = (await res.json()) as typeof json;
  } catch {
    return null;
  }

  if (!json?.result || json.result.status !== "success") return null;
  const data = json.result.data;
  return typeof data === "string" && data.length > 0 ? data : null;
}
