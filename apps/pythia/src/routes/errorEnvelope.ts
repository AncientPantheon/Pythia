/**
 * Stable discriminators for Pythia's OWN error envelopes. Every `{error, ...}`
 * body the routes emit also carries one of these `code` values so the consumer
 * SDK can distinguish a Pythia-origin error from a node error forwarded verbatim
 * by the relay — WITHOUT sniffing the human-readable `error` message. A node's
 * own `{error:"…"}` body carries no `code`, so it is passed through, not remapped.
 */
export const PYTHIA_VALIDATION = "pythia_validation";
export const PYTHIA_UNSUPPORTED_CHAIN = "pythia_unsupported_chain";
export const PYTHIA_UPSTREAM = "pythia_upstream";
export const PYTHIA_POOL_EXHAUSTED = "pythia_pool_exhausted";

/** The union of every Pythia error-envelope discriminator. */
export type PythiaErrorCode =
  | typeof PYTHIA_VALIDATION
  | typeof PYTHIA_UNSUPPORTED_CHAIN
  | typeof PYTHIA_UPSTREAM
  | typeof PYTHIA_POOL_EXHAUSTED;
