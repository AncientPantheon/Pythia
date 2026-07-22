/**
 * Apollo-curve signature verification — PURE PUBLIC-DATA.
 *
 * Given a caller-supplied `signature` over `message` and the half's ON-CHAIN
 * Apollo public key, return whether the signature is valid under that key. This
 * keeps Pythia KEYLESS: it holds no key, never signs, never generates — it only
 * checks a signature against a public key it read from chain itself. Only
 * `Apollo.verify` is ever touched here (NOT `sign` / `generateFrom*`), which is
 * exactly why this is a keyless operation.
 *
 * `@ouronet/dalos-crypto` is ESM and dynamically imported so a load failure
 * degrades to `false` (verification fails closed) rather than crashing the
 * gateway. The Apollo primitive (`dalos-apollo`, the ₱./Π. 1024-bit curve,
 * Schnorr v2) is not auto-registered; we use it directly off the registry export.
 */
export async function apolloVerify(
  signature: string,
  message: string,
  publicKey: string,
): Promise<boolean> {
  if (!signature || !publicKey) return false;
  try {
    const registry = await import("@ouronet/dalos-crypto/registry");
    const apollo = registry.Apollo;
    if (!apollo || typeof apollo.verify !== "function") return false;
    return apollo.verify(signature, message, publicKey) === true;
  } catch {
    return false;
  }
}
