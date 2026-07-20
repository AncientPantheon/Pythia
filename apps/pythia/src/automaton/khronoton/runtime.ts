import { createStoachainRuntime } from "@ancientpantheon/khronoton-core/blockchain/stoachain";
import type { ChainRuntime } from "@ancientpantheon/khronoton-core/server";

/**
 * The ChainRuntime seam — khronoton's `/blockchain/stoachain` adapter wrapping the
 * `@stoachain/*` SDK (client + universal signer + gas + network constants), so we inject
 * ONE object instead of reaching for `@stoachain/*` directly. Built once per process (the
 * promise itself is the singleton). Gas defaults to the Ouronet station; env overrides for
 * a custom node / test network. Signing lives here (automaton core) — never the client path.
 */
const g = globalThis as unknown as { __pythiaKhronotonRuntime?: Promise<ChainRuntime> };

export function getChainRuntime(): Promise<ChainRuntime> {
  if (g.__pythiaKhronotonRuntime) return g.__pythiaKhronotonRuntime;
  g.__pythiaKhronotonRuntime = createStoachainRuntime({
    ...(process.env.KHRONOTON_NODE_BASE_URL ? { nodeBaseUrl: process.env.KHRONOTON_NODE_BASE_URL } : {}),
    ...(process.env.KHRONOTON_NETWORK_ID ? { networkId: process.env.KHRONOTON_NETWORK_ID } : {}),
    ...(process.env.KHRONOTON_NAMESPACE ? { namespace: process.env.KHRONOTON_NAMESPACE } : {}),
    ...(process.env.KHRONOTON_GAS_STATION ? { gasStationAccount: process.env.KHRONOTON_GAS_STATION } : {}),
  });
  return g.__pythiaKhronotonRuntime;
}
