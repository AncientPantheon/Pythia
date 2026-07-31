import { dial, STOA_NETWORK, type DialNode, type FetchImpl } from "../../dial/index.js";
import { buildLocalCommand } from "../../chainweb/localCommand.js";
import { PYTHIA_DUAL_LINK_BAR, APOLLO_ACCOUNT_LEN } from "./dualLinkCache.js";
import { isStandardApollo, isSmartApollo } from "../../routes/connectorVerify.js";

/** The namespace + module the PYTHIA consumer-key reads live in. */
const PYTHIA_NS = "ouronet-ns";

/** The {primary, fallback} nodes to read an Apollo account's counterpart from. */
export interface ApolloCounterpartReadPair {
  primary: DialNode;
  fallback: DialNode;
}

function localReadPath(host: string, chainId: number): string {
  return `${host}/chainweb/0.0/${STOA_NETWORK}/chain/${chainId}/pact/api/v1/local`;
}

/**
 * Read a single Apollo account's linked counterpart via a keyless Pact local
 * read of `(ouronet-ns.PYTHIA.UR_Counterpart (read-string "acct"))`.
 *
 * `apolloAccount` is passed via Pact env-`data` (NOT inlined/interpolated
 * into the Pact code string) — mirrors {@link readApolloPublicKey}'s
 * (`connectors/verify/readApolloPublicKey.ts`) trust-anchor pattern exactly,
 * for the same reason: interpolating caller-influenced input directly into
 * executed Pact source is a code-injection vector (CONFIRMED CRITICAL in
 * review — the account only needs to pass a fixed-length + first-codepoint
 * check before reaching this call, leaving the remaining 160+ characters,
 * including quote characters, completely unconstrained).
 *
 * Mirrors {@link readActiveDualLinkAccounts}'s (`dualLinkCache.ts`)
 * dial/error-handling shape and REJECTS — rather than silently resolving to
 * `null` — on a non-"success" status or a malformed response (e.g. `data`
 * that isn't a string). `null` is returned ONLY for a well-formed response
 * whose `data` equals the on-chain "unlinked" sentinel
 * ({@link PYTHIA_DUAL_LINK_BAR}), meaning `apolloAccount` hasn't been through
 * `C_Link` yet. Any other well-formed string `data` is the counterpart
 * account itself.
 */
export async function readApolloCounterpart(
  pair: ApolloCounterpartReadPair,
  apolloAccount: string,
  opts: { chainId?: number; fetchImpl?: FetchImpl } = {},
): Promise<string | null> {
  const chainId = opts.chainId ?? 0;
  const body = buildLocalCommand(`(${PYTHIA_NS}.PYTHIA.UR_Counterpart (read-string "acct"))`, {
    chainId,
    data: { acct: apolloAccount },
  });

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
  const json = (await res.json()) as { result?: { status?: string; data?: unknown } };

  if (!json?.result || json.result.status !== "success") {
    throw new Error("apollo counterpart read failed");
  }

  const data = json.result.data;
  // A "success" status with a non-string `data` is a malformed/unexpected
  // response, not "unlinked" — this function's whole contract is to REJECT
  // on any failure (including a malformed success) so a caller never
  // mistakes "the read didn't make sense" for a genuine unlinked account.
  if (typeof data !== "string") {
    throw new Error("apollo counterpart read returned malformed data");
  }
  if (data === PYTHIA_DUAL_LINK_BAR) return null;

  // The returned counterpart is fed straight into `PendingActivationTracker`,
  // which joins it with the caller's own account via an unescaped `"|"` (see
  // `pairKey` in pendingActivationTracker.ts) to form a map key. A malformed
  // or unexpectedly-shaped counterpart (CONFIRMED HIGH in review) could
  // collide with, and silently corrupt, an unrelated pending pair — reject
  // here rather than trust the chain response to already be well-formed.
  if (data.length !== APOLLO_ACCOUNT_LEN || !(isStandardApollo(data) || isSmartApollo(data))) {
    throw new Error("apollo counterpart read returned a malformed account string");
  }

  return data;
}
