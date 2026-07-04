/**
 * Decode constants replicated as LOCAL literals instead of imported from
 * `@stoachain/ouronet-core/constants`.
 *
 * The sibling constants barrel re-exports `@stoachain/stoa-core/constants`,
 * which transitively pulls the network host-selection module into the import
 * graph — the exact write-capable transport surface the read-only service must
 * never reach. Replicating two trivial string literals mirrors the Phase-2
 * precedent (`STOA_NETWORK`/`CHAIN_COUNT` replicated in `dial.ts` for the same
 * reason). The Pact expressions and the `mayComeWithDeimal` decoder are still
 * reused from the clean `@stoachain/stoa-core/pact` subpath — only these two
 * literals are copied.
 */

/** The Ouronet Pact namespace prefix (`ouronet-ns.DPTF.*`, etc.). */
export const KADENA_NAMESPACE = "ouronet-ns";

/** The DPTF token id for IGNIS (gas). */
export const TOKEN_ID_IGNIS = "GAS-8Nh-JO8JO4F5";
